# Phase 21: Refactor Components Using Commands Object

## Frontmatter

```yaml
wave: 1
depends_on: [20]
files_modified:
  - src/components/project-picker/ProjectList.tsx
  - src/components/project-picker/ConnectionHeader.tsx
  - src/components/project-picker/FilePicker.tsx
  - src/components/common/SettingsPage.tsx
  - src/utils/hooks/useSshConnectionManager.ts
  - src/services/connection.service.ts
  - src/services/project.service.ts
autonomous: false
must_haves:
  truths:
    - "No components directly import 'commands' from @src/types/bindings.ts"
    - "All 15 direct command usages replaced with service hook calls"
    - "Service layer encapsulates all Tauri IPC for components"
  artifacts:
    - path: "src/services/connection.service.ts"
      provides: "File browser and SSH operation hooks"
      min_lines: 240
    - path: "src/services/project.service.ts"
      provides: "Project operation hooks"
      min_lines: 160
    - path: "src/components/project-picker/ProjectList.tsx"
      provides: "Project list component using service hooks"
    - path: "src/components/project-picker/ConnectionHeader.tsx"
      provides: "SSH connection management using service hooks"
    - path: "src/components/project-picker/FilePicker.tsx"
      provides: "File browser using service hooks"
    - path: "src/components/common/SettingsPage.tsx"
      provides: "Settings page using service hooks"
    - path: "src/utils/hooks/useSshConnectionManager.ts"
      provides: "SSH connection manager using service hooks"
  key_links:
    - from: "src/components/project-picker/FilePicker.tsx"
      to: "src/services/connection.service.ts"
      via: "useListLocalDirectories, useListRemoteDirectories, useGetDefaultFilePickerPath, useListDrives"
    - from: "src/components/project-picker/ProjectList.tsx"
      to: "src/services/project.service.ts"
      via: "useCreateProject, useProjectById, useRemoveProject"
    - from: "src/components/common/SettingsPage.tsx"
      to: "src/services/project.service.ts"
      via: "useProjectSettings, useUpdateProjectSettings"
    - from: "src/components/project-picker/ConnectionHeader.tsx"
      to: "src/services/connection.service.ts"
      via: "useDeleteSshConnection, useForgetSavedPassword"
    - from: "src/utils/hooks/useSshConnectionManager.ts"
      to: "src/services/connection.service.ts"
      via: "useConnectSsh, useCreateSshConnection, useConnectSshWithCreds"
```

## Overview

Phase 21 eliminates direct usage of the auto-generated `commands` object from TypeScript bindings in components and hooks. After Phase 19 (service layer creation) and Phase 20 (TanStack Query integration), 5 files still import and use `commands.` directly, bypassing the service layer abstraction.

**Files affected:** 5 files with 15 direct `commands.` usages
- ProjectList.tsx (3 usages: createProject, getProject, removeProject)
- ConnectionHeader.tsx (2 usages: deleteSshConnection, forgetSavedPassword)
- FilePicker.tsx (4 usages: listLocalDirectories, listRemoteDirectories, getDefaultFilePickerPath, listDrives)
- SettingsPage.tsx (2 usages: getProjectSettings, updateProjectSettings)
- useSshConnectionManager.ts (4 usages: connectSshWithoutCredentials, saveSshConnection, connectSshWithPassword)

**Solution approach:**
1. Create missing service hooks in connection.service.ts and project.service.ts
2. Refactor components to use service hooks instead of direct commands
3. Verify no direct commands usage remains outside service layer

## Tasks

### Task 1: Extend connection.service.ts with missing hooks

**Description:**
Create TanStack Query hooks for file browser operations (listLocalDirectories, listRemoteDirectories, getDefaultFilePickerPath, listDrives) in the connection service. These hooks wrap direct commands calls currently in FilePicker.tsx.

**Steps:**
1. Open `src/services/connection.service.ts`
2. Add query key factory entries for file browser operations:
   - `fileBrowser: () => [...connectionQueryKeys.baseKey, "file-browser"]`
   - `localDirs: (path: string) => [...connectionQueryKeys.fileBrowser(), "local", path]`
   - `remoteDirs: (connectionId: number, path: string) => [...]`
   - `defaultPath: () => [...connectionQueryKeys.fileBrowser(), "default-path"]`
   - `drives: () => [...connectionQueryKeys.fileBrowser(), "drives"]`
3. Add mutation hooks:
   - `useListLocalDirectories()` - mutate with path string, returns directory list
   - `useListRemoteDirectories()` - mutate with {connectionId, path}, returns directory list
   - `useGetDefaultFilePickerPath()` - query hook, returns default path
   - `useListDrives()` - query hook, returns array of drive letters (Windows)
4. All hooks use `api.` wrapper for commands unwrapping
5. All hooks follow existing pattern (toast on error, proper query key structure)

**Verification:**
- [ ] All four new hooks are exported from connection.service.ts
- [ ] Hooks use consistent query key factory structure
- [ ] Error handling uses toast.error() consistently

---

### Task 2: Extend project.service.ts with batch project operations

**Description:**
Create TanStack Query hooks for project operations currently called directly in ProjectList.tsx and SettingsPage.tsx. Extend existing project service with missing mutations for getProject, removeProject batch operations.

**Steps:**
1. Open `src/services/project.service.ts`
2. Verify query hook for single project fetch (already exists as `useProjectById`):
   - `useProjectById(projectId: number)` - fetches single project by ID (uses existing detail query key)
3. Verify `useRemoveProject()` mutation already exists and supports removal
4. Verify `useProjectSettings()` and `useUpdateProjectSettings()` already exist
5. Ensure all hooks have proper toast feedback and cache invalidation

**Verification:**
- [ ] useProjectById hook fetches single project correctly
- [ ] useRemoveProject invalidates project list and detail caches
- [ ] useUpdateProjectSettings invalidates settings cache
- [ ] All project operations use service layer properly

---

### Task 3: Refactor ProjectList.tsx to use service hooks

**Description:**
Replace direct commands usage in ProjectList.tsx with service hooks from project and connection services.

**Changes:**
1. Open `src/components/project-picker/ProjectList.tsx`
2. Remove `import { commands } from "@/types"`
3. Add import: `import { useCreateProject, useProjectById, useRemoveProject } from "@/services/project.service"`
4. In `handleProjectSelect()`:
   - Replace `commands.createProject(selectedPath, connectionId ?? null)` with `useCreateProject().mutateAsync(...)`
   - Use result directly (api wrapper handles unwrapping)
5. In `handleProjectClick()`:
   - Replace `commands.getProject(projectId)` with `useProjectById(projectId).data` or refetch via query
   - Consider if query hook is better (caching) vs mutation
6. In `handleRemoveProject()`:
   - Replace `commands.removeProject(projectId)` with `useRemoveProject().mutateAsync(projectId)`
7. Update error handling to catch promise rejections (service layer throws on errors)
8. Remove try-catch blocks where service hooks handle errors with toast

**Verification:**
- [ ] No `commands.` imports or usage in ProjectList.tsx
- [ ] All project operations use service hooks
- [ ] Error handling works (toasts display on failures)
- [ ] Component still functions correctly

---

### Task 4: Refactor ConnectionHeader.tsx to use service hooks

**Description:**
Replace direct commands usage in ConnectionHeader.tsx with service hooks for SSH connection operations.

**Changes:**
1. Open `src/components/project-picker/ConnectionHeader.tsx`
2. Remove `import { commands, SshConnection } from "@/types"`
3. Keep `import { SshConnection } from "@/types"` (type import)
4. Add imports: `import { useDeleteSshConnection, useForgetSavedPassword } from "@/services/connection.service"`
5. In `handleDeleteConnection()`:
   - Replace `await commands.deleteSshConnection(connection.id)` with `useDeleteSshConnection().mutateAsync(connection.id)`
   - Remove try-catch (service hook handles toast)
   - Keep `onDelete()` callback call
6. In `handleForgetPassword()`:
   - Replace `await commands.forgetSavedPassword(connection.id)` with `useForgetSavedPassword().mutateAsync(connection.id)`
   - Remove try-catch (service hook handles toast)
7. Initialize mutations outside event handlers using hooks (not inside event handlers):
   ```typescript
   const deleteConnectionMutation = useDeleteSshConnection();
   const forgetPasswordMutation = useForgetSavedPassword();
   ```
8. Use `.mutateAsync()` in event handlers

**Verification:**
- [ ] No `commands.` imports or usage in ConnectionHeader.tsx
- [ ] All SSH connection operations use service hooks
- [ ] Component still functions correctly

---

### Task 5: Refactor FilePicker.tsx to use service hooks

**Description:**
Replace direct commands usage in FilePicker.tsx with new service hooks for file browser operations.

**Changes:**
1. Open `src/components/project-picker/FilePicker.tsx`
2. Remove `import { commands, SshConnection } from "@/types/bindings"`
3. Keep only `import { SshConnection } from "@/types/bindings"` (type import)
4. Add imports from connection service:
   ```typescript
   import {
     useListLocalDirectories,
     useListRemoteDirectories,
     useGetDefaultFilePickerPath,
     useListDrives,
   } from "@/services/connection.service"
   ```
5. Replace the three useMutation calls:
   - `listLocalDirsMutation`: Replace `mutationFn: (path: string) => commands.listLocalDirectories(path)` with using new service hook
   - `listRemoteDirsMutation`: Similar replacement
   - `getDefaultPathMutation`: Replace with `useGetDefaultFilePickerPath()` query hook
   - `listDrivesMutation`: Replace with `useListDrives()` query hook
6. Note: File browser mutations may need to stay as mutations since they're conditional on user actions
7. Update all references to use service hooks properly

**Verification:**
- [ ] No `commands.` imports or usage in FilePicker.tsx
- [ ] All file listing operations use service hooks
- [ ] Component still functions correctly

---

### Task 6: Refactor useSshConnectionManager.ts to use service hooks

**Description:**
Replace direct commands usage in the useSshConnectionManager hook with service hooks for SSH connection operations.

**Changes:**
1. Open `src/utils/hooks/useSshConnectionManager.ts`
2. Remove `import { commands, SshConnection } from "@/types/bindings.ts"`
3. Keep only `import { SshConnection } from "@/types/bindings.ts"` (type import)
4. Add imports from connection service:
   ```typescript
   import {
     useConnectSsh,
     useConnectSshWithCreds,
     useCreateSshConnection,
   } from "@/services/connection.service"
   ```
5. In `initiateConnection()`:
   - Replace `await commands.connectSshWithoutCredentials(connId)` with `useConnectSsh().mutateAsync({connectionId: connId})`
6. In `handleNewConnection()`:
   - Replace `commands.saveSshConnection(connectionString, "Agent")` with `useCreateSshConnection().mutateAsync({...})`
7. In `handlePasswordSubmit()`:
   - Replace `commands.connectSshWithPassword(connectionId, password, savePassword)` with `useConnectSshWithCreds().mutateAsync({...})`
8. Initialize mutations at hook level using hooks, then use `.mutateAsync()` in callback functions

**Verification:**
- [ ] No `commands.` imports or usage in useSshConnectionManager.ts
- [ ] All SSH operations use service hooks
- [ ] Hook still functions correctly

---

### Task 7: Comprehensive verification and testing

**Description:**
Verify that all direct commands usage has been eliminated and the application works correctly.

**Steps:**
1. Run grep to verify no remaining direct commands usage:
   ```bash
   grep -r "commands\." src/ --include="*.tsx" --include="*.ts" | grep -v "src/services/" | grep -v "src/types/"
   ```
   Expected: Only results in service layer files and type bindings (not components/hooks)
2. Run TypeScript type check:
   ```bash
   pnpm tsc --noEmit
   ```
   Expected: No TypeScript errors
3. Test the application in dev mode:
   ```bash
   pnpm tauri:dev
   ```
   - Navigate through project picker (test local and SSH connections)
   - Test file browser functionality (list directories, navigate)
   - Test project creation and deletion
   - Test connection management (delete, rename, forget password)
   - Test settings page (load/save settings)
4. Run production build:
   ```bash
   pnpm tauri build
   ```
   Expected: Build succeeds with no TypeScript errors
5. If there are any failures in steps 1-4, fix them immediately

**Verification:**
- [ ] Grep shows no direct commands usage outside service layer
- [ ] TypeScript type check passes
- [ ] Application functions correctly in dev mode
- [ ] Production build succeeds

---

## Success Criteria (Goal-Backward Verification)

All success criteria from Phase 21 MUST be TRUE:

1. **No direct commands imports** - Grep confirms zero `commands.` usage outside service/types
2. **All components use service hooks** - 5 files (ProjectList, ConnectionHeader, FilePicker, SettingsPage, useSshConnectionManager) import from services only
3. **Type safety maintained** - TypeScript compilation succeeds with no errors
4. **Loading/error states work** - Service hooks handle loading states and errors with toast
5. **Production build passes** - `pnpm tauri build` succeeds with no errors

## Must-Haves for Executor

These items MUST be completed for phase success:

- [ ] `useListLocalDirectories()` hook created and exported
- [ ] `useListRemoteDirectories()` hook created and exported
- [ ] `useGetDefaultFilePickerPath()` hook created and exported
- [ ] `useListDrives()` hook created and exported
- [ ] `useDeleteSshConnection()` hook exists and exported
- [ ] `useForgetSavedPassword()` hook exists and exported
- [ ] ProjectList.tsx refactored (no commands import)
- [ ] ConnectionHeader.tsx refactored (no commands import)
- [ ] FilePicker.tsx refactored (no commands import)
- [ ] SettingsPage.tsx refactored (no commands import)
- [ ] useSshConnectionManager.ts refactored (no commands import)
- [ ] Grep verification: zero direct commands usage outside service layer
- [ ] TypeScript compilation succeeds
- [ ] Production build succeeds

## Notes

- The `api` proxy wrapper in `tauri-utils.ts` already handles Result unwrapping, so service hooks don't need to manually unwrap
- FilePicker.tsx uses mutations within useEffect, which is appropriate since directory loading happens on state change
- useSshConnectionManager.ts is a custom hook (not a React component), but still benefits from using service hooks for consistency
- All error handling is delegated to service layer (toast.error in onError callbacks)
- Cache invalidation is handled automatically by TanStack Query onSuccess/onSettled callbacks in service hooks
