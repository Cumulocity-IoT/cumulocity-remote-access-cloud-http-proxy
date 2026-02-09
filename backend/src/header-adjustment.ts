import { ConnectionDetails } from "./connection-details";
import { IncomingHttpHeaders } from "http";
import { name, version } from "../package.json";
import * as cookieLib from "cookie-parse";

export class HeaderAdjustment {
  private static headersToRemove = [];
  private static headerPrefix = "rca-http-header-";
  static adjust(headers: IncomingHttpHeaders, details: ConnectionDetails) {
    this.adjustAuthorization(headers);
    const keysToAdd: IncomingHttpHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (this.headersToRemove.includes(key)) {
        delete headers[key];
        continue;
      }

      if (key.toLowerCase() === "user-agent") {
        keysToAdd[key] = `${name}/${version}`;
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
    if (headers.cookie) {
      const { "XSRF-TOKEN": xsrf } = cookieLib.parse(headers.cookie || "");
      if (xsrf) {
        keysToAdd["x-xsrf-token"] = xsrf;
      }
    }
    Object.assign(headers, keysToAdd);
    const host = headers.host || headers.Host;
    delete headers.host;
    headers.Host = host;
  }

  private static adjustAuthorization(headers: IncomingHttpHeaders) {
    let hadCookieAuth = false;
    if (headers.cookie) {
      const newCookieValue = this.adjustCookie(headers.cookie);
      if (newCookieValue !== headers.cookie) {
        hadCookieAuth = true;
      }
      headers.cookie = newCookieValue;
      if (headers.cookie === "") {
        delete headers.cookie;
      }
    }

    if (!hadCookieAuth) {
      // should not pass basic auth for c8y on
      if (headers.authorization) {
        delete headers.authorization;
      }
      return;
    }

    // we want to keep the authorization header if the actual auth was cookie based
    // but we want to remove the fake basic auth header added by the microservice proxy
    if (!headers.authorization?.startsWith("Basic ")) {
      return;
    }

    const token = headers.authorization.replace(/^Basic\s/, "");
    const decodedToken = Buffer.from(token, "base64").toString("utf-8");
    if (decodedToken.endsWith(":<fake password>")) {
      delete headers.authorization;
    }
  }

  private static adjustCookie(currentCookieValue: string) {
    if (!currentCookieValue?.length) {
      return currentCookieValue;
    }

    const cookieKeysToReplace = ["authorization", "XSRF-TOKEN"];
    const replacedCookies = cookieKeysToReplace.reduceRight((prev, curr) => {
      return this.removeCookieByName(prev, curr);
    }, currentCookieValue);
    return replacedCookies.replaceAll("cloud-http-proxy-", "");
  }

  private static removeCookieByName(cookieValue: string, name: string) {
    const regex = new RegExp("(^| )" + name + "=([^;]+;?)", "gi");
    return cookieValue.replace(regex, "");
  }
}
