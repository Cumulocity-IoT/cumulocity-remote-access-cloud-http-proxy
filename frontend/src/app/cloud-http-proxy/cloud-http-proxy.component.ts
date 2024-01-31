import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AlertService, CoreModule } from '@c8y/ngx-components';
import { NEVER, Observable, combineLatest } from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  take,
  tap,
} from 'rxjs/operators';
import { AsyncPipe, NgClass, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { proxyContextPath } from './cloud-http-proxy.model';

@Component({
  selector: 'remote-access-cloud-http-proxy',
  templateUrl: './cloud-http-proxy.component.html',
  standalone: true,
  imports: [CoreModule, NgIf, AsyncPipe, NgClass],
})
export class CloudHttpProxyComponent {
  private readonly pathToProxyMS = `/service/${proxyContextPath}` as const;
  pathToProxyMS$: Observable<string>;
  safePathToProxyMS$: Observable<SafeResourceUrl>;
  showLoader = true;

  constructor(
    private activatedRoute: ActivatedRoute,
    private alertService: AlertService,
    private sanitizer: DomSanitizer
  ) {
    this.pathToProxyMS$ = combineLatest([
      this.activatedRoute.params,
      this.activatedRoute.parent?.params || NEVER,
    ]).pipe(
      map(([paramsFromCurrentRoute, paramsFromParentRoute]) => {
        const { cloudProxyConfigId } = paramsFromCurrentRoute;
        const { id: cloudProxyDeviceId } = paramsFromParentRoute;

        const data = { cloudProxyConfigId, cloudProxyDeviceId };

        if (!cloudProxyConfigId || !cloudProxyDeviceId) {
          return null as unknown as typeof data;
        }

        return data;
      }),
      filter((data) => !!data),
      map(({ cloudProxyConfigId, cloudProxyDeviceId }) => {
        return `${this.pathToProxyMS}/${cloudProxyDeviceId}/${cloudProxyConfigId}/` as const;
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

  iframeLoaded(event: any) {
    this.showLoader = false;
  }

  async openInNewTab() {
    this.alertService.info(
      'Keep in mind that you can only have one http proxy session at a time.'
    );
    const path = await this.pathToProxyMS$.pipe(take(1)).toPromise();
    if (path) {
      window.open(path, '_blank')?.focus();
    }
  }
}
