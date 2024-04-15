import { Injectable } from '@angular/core';
import { FetchClient, InventoryService } from '@c8y/client';

export interface CloudHTTPProxyPathConfig {
  path: string;
  label: string;
}

export interface CloudHTTPProxyPathConfigs {
  [key: string]: CloudHTTPProxyPathConfig[];
}

@Injectable({
  providedIn: 'root'
})
export class RemoteAccessService {
  static pathFragment = 'cloudHTTPProxyPathConfigs';

constructor(private inventory: InventoryService) {}

async updatePathConfig(deviceId: string, config: CloudHTTPProxyPathConfigs) {
  const response = await this.inventory.update({
    id: deviceId,
    [RemoteAccessService.pathFragment]: config
  });

  return response.data[RemoteAccessService.pathFragment];
}

}
