import type { WorkspaceInfo } from './types.ts';

export const CLOUD_LINK = 'https://hive-7f3a.hivecloud.app';

export const workspaceInfo: WorkspaceInfo = {
  name: 'hive-playground',
  cloudLink: CLOUD_LINK,
  repository: 'github.com/hive-demo/hive-playground',
  branch: 'main',
  serverPath: '/srv/hive/hive-playground',
  region: 'Frankfurt',
};
