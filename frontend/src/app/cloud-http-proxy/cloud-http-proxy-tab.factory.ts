import { Injectable } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IManagedObject } from '@c8y/client';
import { ExtensionFactory, Tab, ViewContext } from '@c8y/ngx-components';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { CloudHttpProxyAvailabilityService } from './cloud-http-proxy-available';

@Injectable({
  providedIn: 'root',
})
export class CloudHttpProxyTabFactory implements ExtensionFactory<Tab> {
  static remoteAccessConnectPrefix = 'http:';
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
        config?.name?.startsWith(
          CloudHttpProxyTabFactory.remoteAccessConnectPrefix
        )
    );

    return this.canActivate$.pipe(
      filter((canActive) => !!canActive),
      map(() =>
        this.createTabsForConfigs(httpPrefixedPassthroughConfigs, device)
      )
    );
  }

  createTabsForConfigs(
    httpPrefixedPassthroughConfigs: Array<{
      protocol: string;
      id: string;
      name: string;
    }>,
    device: IManagedObject
  ) {
    return httpPrefixedPassthroughConfigs.map(({ id, name }) => {
      const newName = name.replace(
        CloudHttpProxyTabFactory.remoteAccessConnectPrefix,
        ''
      );
      const tab: Tab = {
        path: `/device/${device.id}/cloud-http-proxy/${id}`,
        label: `${newName}`,
        icon: `window-restore`,
      };
      return tab;
    });
  }
}
