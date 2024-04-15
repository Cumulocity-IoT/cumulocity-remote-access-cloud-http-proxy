import { EnvironmentInjector, NgModule } from '@angular/core';
import { NavigationStart, Router, RouterModule } from '@angular/router';
import { filter, first } from 'rxjs/operators';

@NgModule({
  imports: [
    RouterModule.forChild([])
  ]
})
export class UnlockPassthroughFeatureModule {
  constructor(private injector: EnvironmentInjector, private router: Router) {
    this.router.events
    .pipe(
      filter(e => e instanceof NavigationStart),
      first()
    )
    .subscribe(() => {
      const angularJsInjector = this.injector.get('$injector', null);
      if (angularJsInjector) {
        const c8ySettings = angularJsInjector.get('c8ySettings');
        const q = angularJsInjector.get('$q');
        if (c8ySettings && q) {
          const originalGetSystemOptionValueFn = c8ySettings.getSystemOptionValue;

          c8ySettings.getSystemOptionValue = (optionDetails: any, ...others: any[]) => {
            if (
              optionDetails &&
              optionDetails.category === 'remoteaccess' &&
              optionDetails.key === 'pass-through.enabled'
            ) {
              return q.resolve(true);
            }
            return originalGetSystemOptionValueFn(optionDetails, ...others);
          };
        }
      }
    });
  }
}
