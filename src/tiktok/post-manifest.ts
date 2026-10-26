import type { DeviceIdentity } from '../types.js';

export interface PostManifest {
    device: DeviceIdentity;
    files: Array<{ path: string; name: string; mimeType: string }>;
    musicUrl?: string;
    caption?: string;
    account?: string;
    destination: 'draft' | 'publish';
}
