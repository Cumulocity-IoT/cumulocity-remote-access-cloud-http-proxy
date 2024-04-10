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

@Component({
  selector: 'remote-access-cloud-http-proxy',
  templateUrl: './cloud-http-proxy.component.html',
  standalone: true,
  imports: [CoreModule, NgIf, AsyncPipe, NgClass],
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
  }>;
  destroy = new Subject<void>();
  key = '';
  value = '';

  constructor(
    private activatedRoute: ActivatedRoute,
    private sanitizer: DomSanitizer,
    private modal: BsModalService,
    private tracking: ProxyTrackingService
  ) {
    this.details$ = combineLatest([
      this.activatedRoute.params,
      this.activatedRoute.data,
      this.activatedRoute.parent?.params || NEVER,
    ]).pipe(
      map(
        ([
          paramsFromCurrentRoute,
          dataFromCurrentRoute,
          paramsFromParentRoute,
        ]) => {
          const { secure } = dataFromCurrentRoute;
          const { cloudProxyConfigId } = paramsFromCurrentRoute;
          const { id: cloudProxyDeviceId } = paramsFromParentRoute;

          const data = { cloudProxyConfigId, cloudProxyDeviceId, secure };

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
      map(({ cloudProxyConfigId, cloudProxyDeviceId, secure }) => {
        this.tracking.triggerGainSightEvent('opening-page', {
          secure,
          cloudProxyConfigId,
          cloudProxyDeviceId,
        });
        return `${this.pathToProxyMS}${
          secure ? '/s' : ''
        }/${cloudProxyDeviceId}/${cloudProxyConfigId}/` as const;
      }),
      distinctUntilChanged(),
      tap(() => {
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
}
