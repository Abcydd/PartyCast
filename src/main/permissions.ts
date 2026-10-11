const allowedPermissions = new Set(['fullscreen'])

export function allowAppPermission(isOwnAppContents: boolean, permission: string): boolean {
  return isOwnAppContents && allowedPermissions.has(permission)
}
