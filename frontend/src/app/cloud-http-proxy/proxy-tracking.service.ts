import { Injectable, Optional } from '@angular/core';
import { GainsightService, PxEventData } from '@c8y/ngx-components';

@Injectable({
  providedIn: 'root'
})
export class ProxyTrackingService {

constructor(@Optional() private gainsight: GainsightService) { }

triggerGainSightEvent(
  eventName: string,
  props?: PxEventData | undefined
) {
  try {
    this.gainsight.triggerEvent(`cloud-http-proxy-${eventName}`, props);
  } catch (e) {
    console.warn('Failed to trigger Gainsight event', e);
  }
}

}
