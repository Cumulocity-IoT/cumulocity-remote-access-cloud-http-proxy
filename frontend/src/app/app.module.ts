import { NgModule } from '@angular/core';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { RouterModule as ngRouterModule } from '@angular/router';
import {
  BootstrapComponent,
  CoreModule,
  RouterModule,
} from '@c8y/ngx-components';
import { AssetsNavigatorModule } from '@c8y/ngx-components/assets-navigator';
import {
  DeviceInfoDashboardModule,
  DeviceManagementHomeDashboardModule,
} from '@c8y/ngx-components/context-dashboard';

@NgModule({
  imports: [
    BrowserAnimationsModule,
    ngRouterModule.forRoot([], { enableTracing: false, useHash: true }),
    RouterModule.forRoot(),
    CoreModule.forRoot(),
    DeviceManagementHomeDashboardModule,
    AssetsNavigatorModule.config(),
  ],
  bootstrap: [BootstrapComponent],
})
export class AppModule {}
