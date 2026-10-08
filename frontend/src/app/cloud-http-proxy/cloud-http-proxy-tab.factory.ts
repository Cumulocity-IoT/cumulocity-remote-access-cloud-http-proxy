import { Injectable } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IManagedObject } from '@c8y/client';
import {
  ContextRouteService,
  ExtensionFactory,
  Tab,
  ViewContext,
} from '@c8y/ngx-components';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { CloudHttpProxyAvailabilityService } from './cloud-http-proxy-available';
import {
  CloudHTTPProxyPathConfig,
  CloudHTTPProxyPathConfigs,
  RemoteAccessService,
} from './cloud-http-proxy-path/remote-access.service';
import { parseConnectionName } from './connection-name';

@Injectable({
  providedIn: 'root',
})
export class CloudHttpProxyTabFactory implements ExtensionFactory<Tab> {
  private canActivate$: Observable<boolean>;

  constructor(
    private proxyAvailability: CloudHttpProxyAvailabilityService,
    private context: ContextRouteService
  ) {
    this.canActivate$ = this.proxyAvailability.canActivate();
  }

  get(
    activatedRoute?: ActivatedRoute | undefined
  ): Tab | Tab[] | Observable<Tab | Tab[]> | Promise<Tab | Tab[]> {
    const data = this.context.getContextData(activatedRoute as ActivatedRoute);
    if (!data) {
      return [];
    }

    const { context, contextData } = data;
    if (context !== ViewContext.Device) {
      return [];
    }

    const device: IManagedObject = contextData as IManagedObject;
    if (!device || !device['c8y_RemoteAccessList']) {
      return [];
    }

    const configs:
      | Array<{ protocol: string; id: string; name: string }>
      | undefined = device['c8y_RemoteAccessList'];
    if (!Array.isArray(configs)) {
      return [];
    }

    // configurations named `http:<label>` / `https:<label>`, optionally with options (`http+mux:<label>`)
    const httpPassthroughConfigs = configs
      .filter((config) => config.protocol === 'PASSTHROUGH')
      .map((config) => ({ config, name: parseConnectionName(config?.name) }))
      .filter(({ name }) => !!name)
      // http tabs first, then https tabs
      .sort((a, b) => Number(a.name.secure) - Number(b.name.secure));

    return this.canActivate$.pipe(
      filter((canActive) => !!canActive),
      map(() =>
        httpPassthroughConfigs
          .map(({ config, name }) => {
            const tabs = this.getCustomPathTabs(config.id, device, name.secure);
            if (tabs.length) {
              return tabs;
            }
            return [this.getDefaultTab(name.label, device, name.secure, config.id)];
          })
          .flat()
      )
    );
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
    label: string,
    device: IManagedObject,
    secure: boolean | undefined,
    id: string
  ) {
    const tab: Tab = {
      path: `/device/${device.id}/${
        secure ? 'secure-' : ''
      }cloud-http-proxy/${id}`,
      label,
      icon: `window-restore`,
    };
    return tab;
  }
}
