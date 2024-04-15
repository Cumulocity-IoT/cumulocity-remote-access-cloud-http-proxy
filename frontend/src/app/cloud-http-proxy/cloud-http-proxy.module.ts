import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CloudHttpProxyComponent } from './cloud-http-proxy.component';
import { ViewContext, hookRoute, hookTab } from '@c8y/ngx-components';
import { CloudHttpProxyTabFactory } from './cloud-http-proxy-tab.factory';
import { UnlockPassthroughFeatureModule } from '../unlock-passthrough-feature/unlock-passthrough-feature.module';

@NgModule({
  imports: [CommonModule, CloudHttpProxyComponent, UnlockPassthroughFeatureModule],
  providers: [
    hookRoute([
      {
        path: 'cloud-http-proxy/:cloudProxyConfigId',
        tabs: [],
        label: 'dummy',
        data: {
          secure: false,
        },
        component: CloudHttpProxyComponent,
        context: ViewContext.Device,
      },
    ]),
    hookRoute([
      {
        path: 'secure-cloud-http-proxy/:cloudProxyConfigId',
        tabs: [],
        label: 'dummy',
        data: {
          secure: true,
        },
        component: CloudHttpProxyComponent,
        context: ViewContext.Device,
      },
    ]),
    hookTab(CloudHttpProxyTabFactory),
  ],
})
export class CloudHttpProxyModule {}
