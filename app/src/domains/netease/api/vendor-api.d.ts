/**
 * vendored @neteasecloudmusicapienhanced/api 的类型声明（浏览器适配后）。
 * 仅声明白名单入口与本包 util 的注入面；未列出的子路径视为不引入（红线：song_url_match 等不打包）。
 */

export interface NeteaseApiAnswer {
  status: number;
  body: Record<string, unknown>;
  cookie: string[];
}

export type NeteaseRequestFn = (
  uri: string,
  data: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<NeteaseApiAnswer>;

export type NeteaseApiModule = (data: Record<string, unknown>, request: NeteaseRequestFn) => Promise<unknown>;

declare module '@neteasecloudmusicapienhanced/api/util/request.js' {
  const createRequest: NeteaseRequestFn & {
    setBrowserHttpTransport(transport: unknown): void;
    setBrowserStorage(storage: { getAnonymousToken(): Promise<string>; getXeapiPublicKey(): Promise<unknown> }): void;
  };
  export default createRequest;
}

declare module '@neteasecloudmusicapienhanced/api/module/*.js' {
  const module: NeteaseApiModule;
  export default module;
}
