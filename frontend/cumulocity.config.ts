import type { ConfigurationOptions } from '@c8y/devkit';
import { author, description, version, license } from './package.json';

export default {
  runTime: {
    author,
    description,
    version,
    name: 'Cloud HTTP proxy',
    contextPath: 'sag-pkg-remote-access-cloud-http-proxy',
    key: 'sag-pkg-remote-access-cloud-http-proxy-application-key',
    contentSecurityPolicy:
      "base-uri 'none'; default-src 'self' 'unsafe-inline' http: https: ws: wss:; connect-src 'self' http: https: ws: wss:;  script-src 'self' *.bugherd.com *.twitter.com *.twimg.com *.aptrinsic.com 'unsafe-inline' 'unsafe-eval' data:; style-src * 'unsafe-inline' blob:; img-src * data: blob:; font-src * data:; frame-src *; worker-src 'self' blob:;",
    dynamicOptionsUrl: '/apps/public/public-options/options.json',
    remotes: {
      'sag-pkg-remote-access-cloud-http-proxy': ['CloudHttpProxyModule'],
    },
    package: 'plugin',
    isPackage: true,
    noAppSwitcher: true,
    exports: [
      {
        name: 'Cloud HTTP proxy',
        module: 'CloudHttpProxyModule',
        path: './src/app/cloud-http-proxy/cloud-http-proxy.module.ts',
        description: 'Allows to interact with webinterface of devices.',
      },
    ],
    license,
  },
  buildTime: {
    federation: [
      '@angular/animations',
      '@angular/cdk',
      '@angular/common',
      '@angular/compiler',
      '@angular/core',
      '@angular/forms',
      '@angular/platform-browser',
      '@angular/router',
      '@c8y/client',
      '@c8y/ngx-components',
      'ngx-bootstrap',
      '@ngx-translate/core',
    ],
    copy: [
      {
        from: '../README.md',
        to: 'README.md',
      },
      { from: '../CHANGELOG.md', to: 'CHANGELOG.md' },
      { from: '../LICENSE', to: 'LICENSE.txt' },
      { from: '../images', to: 'images' },
    ],
  },
} as const satisfies ConfigurationOptions;
