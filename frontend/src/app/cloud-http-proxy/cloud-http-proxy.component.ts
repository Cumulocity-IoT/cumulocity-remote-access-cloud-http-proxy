import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AlertService, CoreModule, GainsightService, Permissions, PxEventData } from '@c8y/ngx-components';
import { NEVER, Observable, Subject, combineLatest } from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  switchMap,
  take,
  takeUntil,
  tap,
} from 'rxjs/operators';
import { AsyncPipe, NgClass, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { proxyContextPath } from './cloud-http-proxy.model';
import { TenantOptionsService } from '@c8y/client';

@Component({
  selector: 'remote-access-cloud-http-proxy',
  templateUrl: './cloud-http-proxy.component.html',
  standalone: true,
  imports: [CoreModule, NgIf, AsyncPipe, NgClass],
})
export class CloudHttpProxyComponent implements OnInit, OnDestroy {
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
  hasTenantOptionAdminPermission = false;
  key = '';
  value = '';

  constructor(
    private activatedRoute: ActivatedRoute,
    private alertService: AlertService,
    private sanitizer: DomSanitizer,
    private tenantOptions: TenantOptionsService,
    private alert: AlertService,
    private permissions: Permissions,
    private gainsight: GainsightService
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
        this.triggerGainSightEvent('opening-page', { secure, cloudProxyConfigId, cloudProxyDeviceId });
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

    this.hasTenantOptionAdminPermission = this.permissions.hasRole(
      'ROLE_OPTION_MANAGEMENT_ADMIN'
    );
  }

  ngOnInit(): void {
    if (!this.hasTenantOptionAdminPermission) {
      return;
    }
    this.details$
      .pipe(
        takeUntil(this.destroy),
        switchMap(({ cloudProxyConfigId, cloudProxyDeviceId }) =>
          this.getTenantOption(cloudProxyConfigId, cloudProxyDeviceId)
        )
      )
      .subscribe(([key, value]) => {
        this.key = key;
        this.value = value;
      });
  }

  async getTenantOption(configId: string, deviceId: string) {
    const key = `credentials.rca-http-header-authorization-${deviceId}-${configId}`;
    try {
      const { data: option } = await this.tenantOptions.detail({
        category: proxyContextPath,
        key,
      });
      return [key, option.value || ''] as const;
    } catch (e) {
      // do nothing
    }
    return [key, ''] as const;
  }

  ngOnDestroy(): void {
    this.destroy.next();
  }

  iframeLoaded(event: any) {
    this.showLoader = false;
  }

  async saveAuthInTenantOption() {
    this.triggerGainSightEvent('save-auth-in-tenant-option', { tenantOptionKey: this.key });
    try {
      await this.tenantOptions.create({
        category: proxyContextPath,
        key: this.key,
        value: this.value,
      });
      this.value = `<<Encrypted>>`;
      this.alert.success('Tenant option saved.');
    } catch (e) {
      this.alert.addServerFailure(e);
    }
  }

  private triggerGainSightEvent(eventName: string, props?: PxEventData | undefined) {
    try {
      this.gainsight.triggerEvent(`cloud-http-proxy-${eventName}`, props);
    } catch (e) {
      console.warn('Failed to trigger Gainsight event', e);
    }
  }
}
