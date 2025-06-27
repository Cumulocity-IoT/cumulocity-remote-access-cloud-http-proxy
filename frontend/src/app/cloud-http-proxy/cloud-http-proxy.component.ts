import { Component, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CoreModule } from '@c8y/ngx-components';
import {
  NEVER,
  Observable,
  Subject,
  combineLatest,
  firstValueFrom,
} from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  tap,
} from 'rxjs/operators';
import { AsyncPipe, NgClass, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { proxyContextPath } from './cloud-http-proxy.model';
import { BsModalService } from 'ngx-bootstrap/modal';
import { CloudHttpProxySettingsComponent } from './cloud-http-proxy-settings/cloud-http-proxy-settings.component';
import { ProxyTrackingService } from './proxy-tracking.service';
import { CloudHttpProxyPathComponent } from './cloud-http-proxy-path/cloud-http-proxy-path.component';
import { CloudHTTPProxyPathConfigs, RemoteAccessService } from './cloud-http-proxy-path/remote-access.service';
import { BsDropdownModule } from 'ngx-bootstrap/dropdown';
import { FetchClient } from '@c8y/client';

@Component({
  selector: 'remote-access-cloud-http-proxy',
  templateUrl: './cloud-http-proxy.component.html',
  standalone: true,
  imports: [CoreModule, NgIf, AsyncPipe, NgClass, BsDropdownModule],
})
export class CloudHttpProxyComponent implements OnDestroy {
  private readonly pathToProxyMS = `/service/${proxyContextPath}` as const;
  pathToProxyMS$: Observable<string>;
  safePathToProxyMS$: Observable<SafeResourceUrl>;
  showLoader = true;
  details$: Observable<{
    cloudProxyConfigId: string;
    cloudProxyDeviceId: string;
    secure?: boolean;
    path: string;
  }>;
  destroy = new Subject<void>();
  key = '';
  value = '';

  constructor(
    private activatedRoute: ActivatedRoute,
    private sanitizer: DomSanitizer,
    private modal: BsModalService,
    private tracking: ProxyTrackingService,
    private client: FetchClient
  ) {
    this.details$ = combineLatest([
      this.activatedRoute.params,
      this.activatedRoute.data,
      this.activatedRoute.parent?.data || NEVER,
    ]).pipe(
      map(
        ([
          paramsFromCurrentRoute,
          dataFromCurrentRoute,
          dataFromParentRoute,
        ]) => {
          const { secure } = dataFromCurrentRoute;
          const { cloudProxyConfigId, cloudProxyPathIndex } = paramsFromCurrentRoute;
          const { contextData: device } = dataFromParentRoute;
          const cloudProxyDeviceId = device.id;

          let path = '/';
          if (cloudProxyPathIndex >= 0) {
            const pathConfigOfDevice: CloudHTTPProxyPathConfigs = device[RemoteAccessService.pathFragment] || {};
            const configsForPath = pathConfigOfDevice[cloudProxyConfigId] || [];
            const pathConfigForConfigId = configsForPath[cloudProxyPathIndex];
            if (pathConfigForConfigId) {
              path = pathConfigForConfigId.path;
            }
          }
          

          const data = { cloudProxyConfigId, cloudProxyDeviceId, secure, path };

          if (!cloudProxyConfigId || !cloudProxyDeviceId) {
            return null as unknown as typeof data;
          }

          return data;
        }
      ),
      filter((data) => !!data),
      distinctUntilChanged()
    );
    this.pathToProxyMS$ = this.details$.pipe(
      map(({ cloudProxyConfigId, cloudProxyDeviceId, secure, path }) => {
        this.tracking.triggerGainSightEvent('opening-page', {
          secure,
          cloudProxyConfigId,
          cloudProxyDeviceId,
          path
        });
        return `${this.pathToProxyMS}${
          secure ? '/s' : ''
        }/${cloudProxyDeviceId}/${cloudProxyConfigId}${path}` as const;
      }),
      distinctUntilChanged(),
      tap((iframeURL) => {
        const options = this.client.getFetchOptions();
        if (options && options.headers) {
          const headers: { [key: string]: string } = options.headers;
          const authString = headers['Authorization'] || headers['authorization'];
          if (authString && authString.startsWith('Basic ')) {
            const base64 = authString.replace('Basic ', '');
            const decoded = atob(base64);
            const userSeparatorIndex = decoded.indexOf(':');
            const user = decoded.substring(0, userSeparatorIndex);
            const password = decoded.substring(userSeparatorIndex + 1);
            // pre-authenticate iframe in case of basic auth
            const req = new XMLHttpRequest();
            req.open('GET', iframeURL, false, user, password);
            req.send();
          }
        }
        this.showLoader = true;
      }),
      shareReplay({ refCount: true, bufferSize: 1 })
    );
    this.safePathToProxyMS$ = this.pathToProxyMS$.pipe(
      map((url) => this.sanitizer.bypassSecurityTrustResourceUrl(url))
    );
  }

  ngOnDestroy(): void {
    this.destroy.next();
  }

  iframeLoaded(event: any) {
    this.showLoader = false;
  }

  async openSettingsModal() {
    const { cloudProxyConfigId, cloudProxyDeviceId } = await firstValueFrom(
      this.details$
    );
    const modalRef = this.modal.show(CloudHttpProxySettingsComponent, {
      initialState: { cloudProxyDeviceId, cloudProxyConfigId },
    });
  }

  async openPathsModal() {
    const { cloudProxyConfigId } = await firstValueFrom(
      this.details$
    );
    this.modal.show(CloudHttpProxyPathComponent, {
      initialState: {device: this.activatedRoute.parent?.snapshot.data['contextData'], cloudProxyConfigId}
    })
  }
}
