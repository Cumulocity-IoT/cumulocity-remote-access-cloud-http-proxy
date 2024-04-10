import { Component, OnInit } from '@angular/core';
import { FetchClient, TenantOptionsService } from '@c8y/client';
import { proxyContextPath } from '../cloud-http-proxy.model';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { AlertService, CoreModule } from '@c8y/ngx-components';
import { KeyValuePipe, NgFor } from '@angular/common';
import { BsModalRef } from 'ngx-bootstrap/modal';
import { ProxyTrackingService } from '../proxy-tracking.service';

@Component({
  selector: 'cloud-http-proxy-settings',
  templateUrl: './cloud-http-proxy-settings.component.html',
  standalone: true,
  imports: [NgFor, ReactiveFormsModule, FormsModule, KeyValuePipe, CoreModule],
})
export class CloudHttpProxySettingsComponent implements OnInit {
  loading = true;
  cloudProxyConfigId: string | undefined;
  cloudProxyDeviceId: string | undefined;
  secure?: boolean | undefined;

  newValue = this.resetNewValue();

  entries = new Map<string, { value: string; cleanedKey: string }>();

  constructor(
    private modalRef: BsModalRef,
    private tracking: ProxyTrackingService,
    private alert: AlertService,
    private tenantOptions: TenantOptionsService,
    private fetch: FetchClient
  ) {}

  async ngOnInit() {
    try {
      const options = await this.listTenantOptions();
      const keySuffix = this.keySuffix();
      for (const [key, value] of Object.entries(options)) {
        if (!key.endsWith(keySuffix)) {
          continue;
        }
        this.addKeyValuePair(key, value);
      }
    } catch (e) {
      this.alert.danger('Failed to load tenant options.');
    }

    this.loading = false;
  }

  addHeader() {
    this.addNewEntry(
      this.newValue.key,
      this.newValue.value,
      this.newValue.encrypt
    );
  }

  async addNewEntry(headerKey: string, headerValue: string, encrypt = true) {
    const keySuffix = this.keySuffix();
    const transformedKey = headerKey.toLowerCase();
    const key = `${
      encrypt ? 'credentials.' : ''
    }rca-http-header-${transformedKey}${keySuffix}`;
    this.tracking.triggerGainSightEvent('save-header-in-tenant-option', {
      tenantOptionKey: transformedKey,
      encrypt,
      cloudProxyDeviceId: this.cloudProxyDeviceId,
      cloudProxyConfigId: this.cloudProxyConfigId,
    });
    try {
      const result = await this.tenantOptions.create({
        category: proxyContextPath,
        key,
        value: headerValue,
      });
      this.addKeyValuePair(key, encrypt ? '<<Encrypted>>' : headerValue);
      this.alert.success('Tenant option saved.');
      this.newValue = this.resetNewValue();
    } catch (e) {
      this.alert.addServerFailure(e);
    }
  }

  addKeyValuePair(key: string, value: string) {
    this.entries.set(key, { cleanedKey: this.cleanKey(key), value });
  }

  async listTenantOptions(): Promise<{ [key: string]: string }> {
    const result = await this.fetch.fetch(
      `/tenant/options/${proxyContextPath}`
    );
    if (result.status === 404) {
      return {};
    }
    if (result.status !== 200) {
      throw Error('Wrong status code', { cause: result });
    }
    const body = await result.json();

    return body;
  }

  close() {
    this.modalRef.hide();
  }

  async removeSetting(key: string) {
    try {
      await this.tenantOptions.delete({ category: proxyContextPath, key: key });
      this.entries.delete(key);
      this.alert.success('Header removed.');
    } catch (e) {
      this.alert.addServerFailure(e);
    }
  }

  private cleanKey(key: string) {
    const removedPrefix = key.replace(/.*rca-http-header-/, '');
    const removedSuffix = removedPrefix.replace(this.keySuffix(), '');

    return removedSuffix;
  }

  private resetNewValue() {
    return {
      key: '',
      value: '',
      encrypt: false,
    };
  }

  private keySuffix() {
    return `-${this.cloudProxyDeviceId}-${this.cloudProxyConfigId}`;
  }
}
