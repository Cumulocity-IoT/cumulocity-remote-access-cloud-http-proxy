import { NgModule, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CloudHttpProxyComponent } from './cloud-http-proxy.component';
import { Route, ViewContext, hookRoute, hookTab } from '@c8y/ngx-components';
import { CloudHttpProxyTabFactory } from './cloud-http-proxy-tab.factory';
import { CookieModule } from 'ngx-cookie';
import { CloudHttpProxyAvailabilityService } from './cloud-http-proxy-available';

@NgModule({
  imports: [CommonModule, CookieModule.withOptions(), CloudHttpProxyComponent],
  providers: [
    hookRoute([
      {
        path: 'cloud-http-proxy/:cloudProxyConfigId',
        tabs: [],
        label: 'dummy',
        component: CloudHttpProxyComponent,
        context: ViewContext.Device,
        // canActivate: [
        //   () => {
        //     inject(CloudHttpProxyAvailabilityService).canActivate();
        //   },
        // ],
      },
    ]),
    hookTab(CloudHttpProxyTabFactory),
  ],
})
export class CloudHttpProxyModule {}
