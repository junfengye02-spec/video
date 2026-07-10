declare module "fflate/browser" {
  export {
    AsyncInflate,
    strFromU8,
    strToU8,
    Unzip,
    UnzipInflate,
    Zip,
    ZipPassThrough,
  } from "fflate";
  export type {
    AsyncFlateStreamHandler,
    UnzipDecoder,
    UnzipFile,
  } from "fflate";
}
