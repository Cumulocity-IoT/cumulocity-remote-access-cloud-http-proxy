import { Injectable } from '@angular/core';
import {
  ISystemOption,
  ITenantOption,
  IUser,
  SystemOptionsService,
  TenantOptionsService,
  UserService,
} from '@c8y/client';
import { AppStateService } from '@c8y/ngx-components';
import { Observable, combineLatest, of } from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  first,
  map,
  shareReplay,
  switchMap,
  tap,
} from 'rxjs/operators';
import { proxyContextPath } from './cloud-http-proxy.model';

@Injectable({ providedIn: 'root' })
export class CloudHttpProxyAvailabilityService {
  constructor(
    private appState: AppStateService,
    private systemOption: SystemOptionsService,
    private tenantOption: TenantOptionsService,
    private userServce: UserService
  ) {}

  canActivate(): Observable<boolean> {
    const currentUserId$ = this.appState.currentUser.pipe(
      map((user) => user?.id),
      distinctUntilChanged(),
      filter((user) => !!user)
    );

    return currentUserId$.pipe(
      map(() => this.ensureUserHasAllRoles()),
      switchMap((hasRequiredRoles) =>
        hasRequiredRoles
          ? combineLatest([this.ensureMicroserviceIsPresent()])
          : of([false])
      ),
      map((res) => res.every((value) => !!value)),
      shareReplay(1)
    );
  }

  ensureUserHasAllRoles(): boolean {
    const user = this.appState.currentUser.value;
    if (!user) {
      return false;
    }

    // TODO: Skipping check since afaik not required to establis connection
    // if (!this.userServce.hasRole(user, 'ROLE_REMOTE_ACCESS_ADMIN')) {
    //   return false;
    // }

    if (
      !this.userServce.hasAnyRole(user, [
        'ROLE_OPTION_MANAGEMENT_READ',
        'ROLE_OPTION_MANAGEMENT_ADMIN',
      ])
    ) {
      return false;
    }

    return true;
  }

  ensureMicroserviceIsPresent(): Observable<boolean> {
    // added for Web SDK version 1017 compatibility
    if (!this.appState.currentAppsOfUser) {
      return of(true);
    }

    return this.appState.currentAppsOfUser.pipe(
      first(),
      map(
        (apps) =>
          !!apps.find(({ contextPath }) => contextPath === proxyContextPath)
      ),
      tap((msPresent) => {
        if (!msPresent) {
          console.warn(
            `Cloud http proxy feature not available as the "${proxyContextPath}" microservice was not found.`
          );
        }
      })
    );
  }

  async ensureXsrfTokenValidationDisabled() {
    return this.ensureOptionIsSetAsExpected(
      this.tenantOption,
      {
        category: 'jwt',
        key: 'xsrf-validation.enabled',
      },
      false
    );
  }

  private async ensureOptionIsSetAsExpected(
    service: TenantOptionsService,
    option: ITenantOption,
    expectedValue: string | boolean
  ): Promise<boolean>;
  private async ensureOptionIsSetAsExpected(
    service: SystemOptionsService,
    option: ISystemOption,
    expectedValue: string | boolean
  ): Promise<boolean>;
  private async ensureOptionIsSetAsExpected(
    service: TenantOptionsService | SystemOptionsService,
    option: ITenantOption | ISystemOption,
    expectedValue: string | boolean
  ): Promise<boolean> {
    let hasExpectedValue = false;
    const { key, category } = option;
    try {
      const { data: retrievedOption } = await service.detail({ key, category });

      const value = retrievedOption.value as string | boolean;
      const expectedValueAsString = `${expectedValue}`;
      hasExpectedValue =
        value === expectedValue || value === expectedValueAsString;
    } catch (e) {
      // do nothing;
    }
    if (!hasExpectedValue) {
      console.warn(
        `Cloud http proxy feature not available as option "${category}.${key}" was not set to the expected value. Please refer to the plugins documentation to set these.`
      );
    }
    return hasExpectedValue;
  }
}
