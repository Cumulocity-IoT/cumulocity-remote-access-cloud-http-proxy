import { ConnectionDetails } from "./connection-details";
import { IncomingHttpHeaders } from "http";

export class HeaderAdjustment {
  private static headersToRemove = ["authorization"];
  private static headerPrefix = "rca-http-header-";
  static adjust(headers: IncomingHttpHeaders, details: ConnectionDetails) {
    const keysToAdd: IncomingHttpHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (this.headersToRemove.includes(key)) {
        delete headers[key];
        continue;
      }

      if (!key.startsWith(this.headerPrefix)) {
        continue;
      }

      delete headers[key];
      const suffix = `-${details.cloudProxyDeviceId}-${details.cloudProxyConfigId}`;
      if (!key.endsWith(suffix)) {
        continue;
      }
      const newKey = key.replace(this.headerPrefix, "").replace(suffix, "");
      keysToAdd[newKey] = value;
    }
    Object.assign(headers, keysToAdd);
    if (headers.cookie) {
      headers.cookie = this.adjustCookie(headers.cookie);
      if (headers.cookie === "") {
        delete headers.cookie;
      }
    }
  }

  private static adjustCookie(currentCookieValue: string) {
    if (!currentCookieValue?.length) {
      return currentCookieValue;
    }

    const cookieKeysToReplace = ["authorization", "XSRF-TOKEN", "ahoi"];
    return cookieKeysToReplace.reduceRight((prev, curr) => {
      return this.removeCookieByName(prev, curr);
    }, currentCookieValue);
  }

  private static removeCookieByName(cookieValue: string, name: string) {
    const regex = new RegExp("(^| )" + name + "=([^;]+;?)", "gi");
    return cookieValue.replace(regex, "");
  }
}
