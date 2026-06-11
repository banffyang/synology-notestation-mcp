/**
 * DSM API Client - Handles authentication and API calls to Synology NAS
 */
import { createHash } from "crypto";

export interface DsmConfig {
  host: string;
  port: number;
  https: boolean;
  account: string;
  password: string;
  otpCode?: string;
  ignoreCert?: boolean;
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
   * Login to DSM and get session ID
   */
  async login(): Promise<string> {
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

    if (this.config.otpCode) {
      params.otp_code = this.config.otpCode;
    }

    const data = await this.postForm("/auth.cgi", params);
    this.sid = data.data.sid;
    this.synoToken = data.data.synotoken || null;
    return this.sid!;
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
      params[k] = String(v);
    }

    if (usePost) {
      return this.postForm(path, params);
    }
    return this.get(path, params);
  }
}
