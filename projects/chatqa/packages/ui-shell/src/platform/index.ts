import { desktopPlatform } from './desktop';
import { pwaPlatform } from './pwa';
import type { Platform } from './types';

declare const __PLATFORM__: 'desktop' | 'pwa';

export const platform: Platform = __PLATFORM__ === 'desktop' ? desktopPlatform : pwaPlatform;
export const isDesktop = __PLATFORM__ === 'desktop';
export * from './types';
