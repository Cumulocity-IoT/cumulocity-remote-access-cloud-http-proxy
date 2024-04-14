import { Injectable } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IManagedObject } from '@c8y/client';
import { ExtensionFactory, Tab, ViewContext } from '@c8y/ngx-components';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { CloudHttpProxyAvailabilityService } from './cloud-http-proxy-available';
import {
  CloudHTTPProxyPathConfig,
  CloudHTTPProxyPathConfigs,
  RemoteAccessService,
} from './cloud-http-proxy-path/remote-access.service';

@Injectable({
  providedIn: 'root',
})
export class CloudHttpProxyTabFactory implements ExtensionFactory<Tab> {
  static remoteAccessConnectPrefix = 'http:';
  static secureRemoteAccessConnectPrefix = 'https:';
  private canActivate$: Observable<boolean>;

  constructor(private proxyAvailability: CloudHttpProxyAvailabilityService) {
    this.canActivate$ = this.proxyAvailability.canActivate();
  }

  get(
    activatedRoute?: ActivatedRoute | undefined
  ): Tab | Tab[] | Observable<Tab | Tab[]> | Promise<Tab | Tab[]> {
    const context: ViewContext | undefined =
      activatedRoute?.snapshot.data?.['context'] ||
      activatedRoute?.parent?.snapshot.data?.['context'];

    if (context !== ViewContext.Device) {
      return [];
    }

    const device: IManagedObject | undefined =
      activatedRoute?.snapshot.data?.['contextData'] ||
      activatedRoute?.parent?.snapshot.data?.['contextData'];

    if (!device || !device['c8y_RemoteAccessList']) {
      return [];
    }

    const configs:
      | Array<{ protocol: string; id: string; name: string }>
      | undefined = device['c8y_RemoteAccessList'];
    if (!Array.isArray(configs)) {
      return [];
    }

    const httpPrefixedPassthroughConfigs = configs.filter(
      (config) =>
        config.protocol === 'PASSTHROUGH' &&
        (config?.name?.startsWith(
          CloudHttpProxyTabFactory.remoteAccessConnectPrefix
        ) ||
          config?.name?.startsWith(
            CloudHttpProxyTabFactory.secureRemoteAccessConnectPrefix
          ))
    );

    return this.canActivate$.pipe(
      filter((canActive) => !!canActive),
      map(() => [
        ...this.createTabsForConfigs(
          httpPrefixedPassthroughConfigs,
          device,
          CloudHttpProxyTabFactory.remoteAccessConnectPrefix
        ),
        ...this.createTabsForConfigs(
          httpPrefixedPassthroughConfigs,
          device,
          CloudHttpProxyTabFactory.secureRemoteAccessConnectPrefix,
          true
        ),
      ])
    );
  }

  createTabsForConfigs(
    httpPrefixedPassthroughConfigs: Array<{
      protocol: string;
      id: string;
      name: string;
    }>,
    device: IManagedObject,
    prefix: string,
    secure?: boolean
  ) {
    return httpPrefixedPassthroughConfigs
      .filter((tmp) => tmp.name.startsWith(prefix))
      .map(({ id, name }) => {
        const tabs = this.getCustomPathTabs(id, device, secure);
        if (tabs.length) {
          return tabs;
        }
        return [this.getDefaultTab(name, prefix, device, secure, id)];
      }).flat();
  }

  private getCustomPathTabs(
    configId: string,
    device: IManagedObject,
    secure?: boolean
  ) {
    const customPathConfigs: CloudHTTPProxyPathConfigs =
      device[RemoteAccessService.pathFragment] || {};
    const customPathConfigsForId: CloudHTTPProxyPathConfig[] =
      customPathConfigs[configId] || [];
    return customPathConfigsForId.map((config, index) => {
      const tab: Tab = {
        path: `/device/${device.id}/${
          secure ? 'secure-' : ''
        }cloud-http-proxy/${configId}/${index}`,
        label: config.label,
        icon: `window-restore`,
      };
      return tab;
    });
  }

  private getDefaultTab(
    name: string,
    prefix: string,
    device: IManagedObject,
    secure: boolean | undefined,
    id: string
  ) {
    const newName = name.replace(prefix, '');
    const tab: Tab = {
      path: `/device/${device.id}/${
        secure ? 'secure-' : ''
      }cloud-http-proxy/${id}`,
      label: `${newName}`,
      icon: `window-restore`,
    };
    return tab;
  }
}
