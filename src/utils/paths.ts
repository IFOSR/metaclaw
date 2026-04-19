import { homedir } from 'os';
import { resolve } from 'path';

export function resolveMetaclawDir(envMetaclawHome = process.env.METACLAW_HOME, userHome = homedir()): string {
  if (envMetaclawHome && envMetaclawHome.trim().length > 0) {
    return resolve(envMetaclawHome);
  }

  return resolve(userHome, '.metaclaw');
}
