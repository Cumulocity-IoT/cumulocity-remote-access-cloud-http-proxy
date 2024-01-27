import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AlertService, CoreModule } from '@c8y/ngx-components';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CookieModule, CookieService, CookieOptions } from 'ngx-cookie';
import { NEVER, Observable, combineLatest } from 'rxjs';
import { filter, map, shareReplay, tap } from 'rxjs/operators';
import { AsyncPipe, NgClass, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { proxyContextPath } from './cloud-http-proxy.model';

@Component({
  selector: 'remote-access-cloud-http-proxy',
  templateUrl: './cloud-http-proxy.component.html',
  standalone: true,
  imports: [CookieModule, CoreModule, NgIf, AsyncPipe, NgClass],
})
export class CloudHttpProxyComponent {
  private readonly pathToProxyMS = `/service/${proxyContextPath}/` as const;
  pathToProxyMS$: Observable<SafeResourceUrl | null>;
  showLoader = true;

  constructor(
    private activatedRoute: ActivatedRoute,
    private cookieService: CookieService,
    private alertService: AlertService,
    private sanitizer: DomSanitizer
  ) {
    const cookieOptions: CookieOptions = {};

    this.pathToProxyMS$ = combineLatest([
      this.activatedRoute.params,
      this.activatedRoute.parent?.params || NEVER,
    ]).pipe(
      takeUntilDestroyed(),
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
      tap(({ cloudProxyConfigId, cloudProxyDeviceId }) => {
        this.cookieService.put(
          'cloudProxyConfigId',
          cloudProxyConfigId,
          cookieOptions
        );
        this.cookieService.put(
          'cloudProxyDeviceId',
          cloudProxyDeviceId,
          cookieOptions
        );
        this.showLoader = true;
      }),
      map(({ cloudProxyConfigId, cloudProxyDeviceId }) => {
        return `${this.pathToProxyMS}?cloudProxyDeviceId=${cloudProxyDeviceId}&cloudProxyConfigId=${cloudProxyConfigId}`;
      }),
      map((url) => this.sanitizer.bypassSecurityTrustResourceUrl(url)),
      shareReplay({ refCount: true, bufferSize: 1 })
    );
  }

  iframeLoaded(event: any) {
    this.showLoader = false;
  }

  openInNewWindow() {
    this.alertService.info(
      'Keep in mind that you can only have one http proxy session at a time.'
    );
    window.open(this.pathToProxyMS, '_blank')?.focus();
  }
}
