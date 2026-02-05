import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { CoreModule, RouterModule } from '@c8y/ngx-components';
import { AssetsNavigatorModule } from '@c8y/ngx-components/assets-navigator';
import { DeviceManagementHomeDashboardModule } from '@c8y/ngx-components/context-dashboard';

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimations(),
    importProvidersFrom(RouterModule.forRoot()),
    importProvidersFrom(CoreModule.forRoot()),
    importProvidersFrom(DeviceManagementHomeDashboardModule),
    importProvidersFrom(AssetsNavigatorModule.config()),
  ],
};
