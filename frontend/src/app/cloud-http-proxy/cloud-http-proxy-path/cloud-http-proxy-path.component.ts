import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CloudHTTPProxyPathConfig, CloudHTTPProxyPathConfigs, RemoteAccessService } from './remote-access.service';
import { KeyValuePipe, NgFor } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { CoreModule, NavigatorService, TabsService } from '@c8y/ngx-components';
import { IManagedObject } from '@c8y/client';
import { BsModalRef } from 'ngx-bootstrap/modal';

@Component({
  selector: 'cloud-http-proxy-path',
  templateUrl: './cloud-http-proxy-path.component.html',
  standalone: true,
  imports: [NgFor, ReactiveFormsModule, FormsModule, KeyValuePipe, CoreModule]
})
export class CloudHttpProxyPathComponent implements OnInit {
  device: IManagedObject | undefined;
  configs: CloudHTTPProxyPathConfig[] = [];
  allConfigs: CloudHTTPProxyPathConfigs | undefined;
  cloudProxyConfigId: string | undefined;

  newValue: CloudHTTPProxyPathConfig = this.resetNewValue();

  constructor(private remoteAccess: RemoteAccessService, private modalRef: BsModalRef, private tabs: TabsService) {
  }

  ngOnInit() {
    this.allConfigs = this.device?.[RemoteAccessService.pathFragment] || {};
    if (!this.cloudProxyConfigId || !this.allConfigs) {
      this.configs = [];
      return;
    }
    this.configs = this.allConfigs[this.cloudProxyConfigId] || [];
  }

  removePath(path: string) {
    this.configs = this.configs.filter(config => config.path !== path);
  }

  addPath() {
    this.configs.push(this.newValue);
    this.newValue = this.resetNewValue();
  }

  cancel() {
    this.modalRef.hide();
  }

  async save() {
    if (!this.cloudProxyConfigId || !this.device || !this.allConfigs) {
      return;
    }
    this.allConfigs[this.cloudProxyConfigId] = this.configs;
    await this.remoteAccess.updatePathConfig(this.device.id, this.allConfigs);
    this.device[RemoteAccessService.pathFragment] = this.allConfigs;
    this.tabs.refresh();
    this.modalRef.hide();
  }

  private resetNewValue() {
    return {
      label: '',
      path: ''
    };
  }

}
