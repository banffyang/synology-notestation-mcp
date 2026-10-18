/**
 * DSM API Client - Handles authentication and API calls to Synology NAS
 */
import { createHash, createHmac } from "crypto";
import { readFileSync } from "fs";

export interface DsmConfig {
  host: string;
  port: number;
  https: boolean;
  account: string;
  password: string;
  otpCode?: string;
  otpSecret?: string;
  otpFile?: string;
  ignoreCert?: boolean;
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30s) ──────────────────────────────────
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, now: number = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(now / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

interface ApiInfo {
  path: string;
  maxVersion: number;
  minVersion: number;
  requestFormat?: string;
}

interface NoteStationApiInfo {
  [key: string]: ApiInfo;
}

export class DsmApiClient {
  private config: DsmConfig;
  private sid: string | null = null;
  private synoToken: string | null = null;
  private baseUrl: string;
  private apiInfo: NoteStationApiInfo | null = null;

  constructor(config: DsmConfig) {
    this.config = config;
    const protocol = config.https ? "https" : "http";
    this.baseUrl = `${protocol}://${config.host}:${config.port}/webapi`;
  }

  private async fetchJson(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const fetchOpts: RequestInit & { headers?: Record<string, string> } = {
      headers: {} as Record<string, string>,
    };
    if (this.synoToken) {
      fetchOpts.headers!["X-SYNO-TOKEN"] = this.synoToken;
    }
    if (this.config.ignoreCert) {
      // @ts-ignore - NODE_TLS_REJECT_UNAUTHORIZED for self-signed certs
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    const response = await fetch(url.toString(), fetchOpts);
    const data = await response.json();

    if (!data.success) {
      throw new Error(`DSM API error: ${JSON.stringify(data)}`);
    }
    return data;
  }

  private async postForm(
    path: string,
    params: Record<string, string>
  ): Promise<any> {
    const url = `${this.baseUrl}/${path.startsWith("/") ? path.slice(1) : path}`;
    const formBody = new URLSearchParams(params);

    const fetchOpts: RequestInit & { headers?: Record<string, string> } = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody.toString(),
    };
    if (this.synoToken) {
      fetchOpts.headers!["X-SYNO-TOKEN"] = this.synoToken;
    }

    if (this.config.ignoreCert) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    const response = await fetch(url, fetchOpts);
    const data = await response.json();

    if (!data.success) {
      throw new Error(`DSM API error: ${JSON.stringify(data)}`);
    }
    return data;
  }

  /**
   * POST form, returning the raw response even on API errors (for 2FA handling)
   */
  private async postFormRaw(
    path: string,
    params: Record<string, string>
  ): Promise<any> {
    const url = `${this.baseUrl}/${path.startsWith("/") ? path.slice(1) : path}`;
    const formBody = new URLSearchParams(params);

    const fetchOpts: RequestInit & { headers?: Record<string, string> } = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody.toString(),
    };
    if (this.synoToken) {
      fetchOpts.headers!["X-SYNO-TOKEN"] = this.synoToken;
    }
    if (this.config.ignoreCert) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    const response = await fetch(url, fetchOpts);
    return response.json();
  }

  /**
   * Resolve a 2FA code: computed from TOTP secret, else read from file, else static.
   */
  private resolveOtpCode(): string | null {
    if (this.config.otpSecret) {
      try {
        return totp(this.config.otpSecret);
      } catch (e: any) {
        throw new Error(`Failed to compute TOTP from secret: ${e.message}`);
      }
    }
    if (this.config.otpFile) {
      try {
        const code = readFileSync(this.config.otpFile, "utf8").trim();
        if (/^\d{6}$/.test(code)) return code;
        throw new Error(
          `OTP file ${this.config.otpFile} does not contain a 6-digit code`
        );
      } catch (e: any) {
        throw new Error(`Failed to read OTP file: ${e.message}`);
      }
    }
    return this.config.otpCode || null;
  }

  /**
   * Login to DSM and get session ID. Handles the 2FA challenge flow:
   * first attempt may return code 403 with an OTP challenge; retry with
   * the code plus the challenge token/ticket.
   *
   * Also handles DSM's TOTP anti-replay: a code is consumed by ONE login
   * per 30 s window. If a previous login already used this window's code
   * (e.g. the MCP server was restarted within the same window), DSM
   * answers the OTP retry with a bare 404 — wait for the next window and
   * retry once with a fresh code.
   */
  async login(): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const data = await this.loginAttempt();

      if (data.success) {
        this.sid = data.data.sid;
        this.synoToken = data.data.synotoken || null;
        return this.sid!;
      }

      if (attempt === 0 && data.error?.code === 404) {
        // Wait out the current TOTP window (+1 s margin), then retry with
        // a freshly computed code.
        const waitMs = 30_000 - (Date.now() % 30_000) + 1_000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      throw new Error(`DSM API error: ${JSON.stringify(data)}`);
    }
  }

  /**
   * One full login pass: initial auth call + 2FA retry if challenged.
   * Returns the raw (final) response without throwing on API errors.
   */
  private async loginAttempt(): Promise<any> {
    const params: Record<string, string> = {
      api: "SYNO.API.Auth",
      version: "7",
      method: "login",
      account: this.config.account,
      passwd: this.config.password,
      session: "NoteStation",
      format: "cookie",
      enable_syno_token: "yes",
    };

    let data = await this.postFormRaw("/auth.cgi", params);

    // 2FA challenge: DSM returns the challenge token either under data (data.otp)
    // or under error.errors (error.errors.token), depending on DSM version.
    const is2faChallenge =
      !data.success &&
      data.error?.code === 403 &&
      Boolean(data.data?.otp || data.error?.errors?.token);

    if (is2faChallenge) {
      const otpCode = this.resolveOtpCode();
      if (!otpCode) {
        throw new Error(
          "DSM login requires 2FA. Set SYNO_OTP_SECRET (base32 TOTP secret), " +
            "SYNO_OTP_FILE (path to a file containing the current 6-digit code), " +
            "or SYNO_OTP_CODE (static code)."
        );
      }
      params.otp_code = otpCode;
      const token = data.data?.token || data.error?.errors?.token;
      if (token) params.otp_token = token;
      const ticket = data.data?.otp_ticket || data.error?.errors?.otp_ticket;
      if (ticket) params.otp_ticket = ticket;
      data = await this.postFormRaw("/auth.cgi", params);
    }

    return data;
  }

  /**
   * Logout from DSM
   */
  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await this.get("entry.cgi", {
        api: "SYNO.API.Auth",
        version: "1",
        method: "logout",
        session: "NoteStation",
        _sid: this.sid,
      });
    } finally {
      this.sid = null;
    }
  }

  /**
   * Get session ID (login if needed)
   */
  async getSession(): Promise<string> {
    if (!this.sid) {
      await this.login();
    }
    return this.sid!;
  }

  /**
   * Discover available NoteStation API endpoints
   */
  async discoverApis(): Promise<NoteStationApiInfo> {
    if (this.apiInfo) return this.apiInfo;

    const sid = await this.getSession();
    const data = await this.get("query.cgi", {
      api: "SYNO.API.Info",
      version: "1",
      method: "query",
      query: "all",
      _sid: sid,
    });

    // Filter for NoteStation APIs only
    const allApis = data.data as Record<string, any>;
    const nsApis: NoteStationApiInfo = {};
    for (const [key, val] of Object.entries(allApis)) {
      if (key.startsWith("SYNO.NoteStation.")) {
        nsApis[key] = val as ApiInfo;
      }
    }
    this.apiInfo = nsApis;
    return this.apiInfo!;
  }

  /**
   * Generic GET request to DSM API
   */
  async get(
    path: string,
    params: Record<string, string>
  ): Promise<any> {
    const sid = await this.getSession();
    const allParams = { ...params, _sid: sid };
    return this.fetchJson(`/${path.startsWith("/") ? path.slice(1) : path}`, allParams);
  }

  /**
   * Call a NoteStation API method
   */
  async callNoteStation(
    apiName: string,
    method: string,
    extraParams: Record<string, string | number> = {}
  ): Promise<any> {
    const apis = await this.discoverApis();
    const apiInfo = apis[apiName];
    if (!apiInfo) {
      throw new Error(`API ${apiName} not found on NAS. Make sure NoteStation is installed.`);
    }

    const sid = await this.getSession();
    const params: Record<string, string> = {
      api: apiName,
      version: String(apiInfo.maxVersion),
      method: method,
      _sid: sid,
    };

    for (const [k, v] of Object.entries(extraParams)) {
      params[k] = String(v);
    }

    return this.get(apiInfo.path, params);
  }

  /**
   * Call a NoteStation API with POST (for create/update operations)
   */
  async callNoteStationPost(
    apiName: string,
    method: string,
    extraParams: Record<string, string | number> = {}
  ): Promise<any> {
    const apis = await this.discoverApis();
    const apiInfo = apis[apiName];
    if (!apiInfo) {
      throw new Error(`API ${apiName} not found on NAS. Make sure NoteStation is installed.`);
    }

    const sid = await this.getSession();
    const params: Record<string, string> = {
      api: apiName,
      version: String(apiInfo.maxVersion),
      method: method,
      _sid: sid,
    };

    for (const [k, v] of Object.entries(extraParams)) {
      params[k] = String(v);
    }

    return this.postForm(apiInfo.path, params);
  }

  /**
   * Raw API call - for discovery of undocumented methods
   */
  async rawCall(
    apiName: string,
    method: string,
    extraParams: Record<string, string | number> = {},
    usePost: boolean = false
  ): Promise<any> {
    const apis = await this.discoverApis();
    const apiInfo = apis[apiName];

    const path = apiInfo ? apiInfo.path : "entry.cgi";
    const version = apiInfo ? String(apiInfo.maxVersion) : "1";

    const sid = await this.getSession();
    const params: Record<string, string> = {
      api: apiName,
      version: version,
      method: method,
      _sid: sid,
    };

    for (const [k, v] of Object.entries(extraParams)) {
      // Never let extra params clobber the reserved request fields
      // (breaks e.g. SYNO.API.Info queries that use `api` as a param).
      if (k === "api" || k === "version" || k === "method" || k === "_sid") continue;
      params[k] = String(v);
    }

    if (usePost) {
      return this.postForm(path, params);
    }
    return this.get(path, params);
  }
}
