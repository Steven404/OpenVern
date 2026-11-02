import { Button, Dialog, DialogContent, TextField } from '@renderer/components/ui';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { paths } from '@renderer/lib/routes';
import { modalReturnFocus, useUiStore } from '@renderer/stores/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { useNavigate } from 'react-router';

/** Last path segment, tolerating trailing slashes and Windows separators. `~` / `/` give an empty string. */
export function folderBasename(path: string): string {
  const parts = path
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  const last = parts.at(-1) ?? '';
  return last === '~' ? '' : last;
}

/** S6.6. Rendered once at the app level; driven by `useUiStore().newProjectOpen`. */
export function NewProjectModal() {
  const open = useUiStore((s) => s.newProjectOpen);
  const close = useUiStore((s) => s.closeNewProject);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      {/* Mounted only while open so the form starts empty each time. */}
      {open ? <NewProjectForm /> : null}
    </Dialog>
  );
}

function NewProjectForm() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const close = useUiStore((s) => s.closeNewProject);
  const expandProject = useUiStore((s) => s.expandProject);
  const formId = useId();
  const isElectron = window.openvern?.isElectron === true;

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createProject({ rootPath: path.trim(), name: name.trim() || undefined }),
    onSuccess: async (project) => {
      expandProject(project.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      navigate(paths.newChat(project.id));
      close();
    },
  });

  const changePath = (next: string) => {
    setPath(next);
    if (!nameTouched) setName(folderBasename(next));
    if (create.isError) create.reset();
  };

  const browse = async () => {
    const picked = await window.openvern?.pickDirectory();
    if (picked) changePath(picked);
  };

  const error = create.error;
  const pathError =
    error instanceof ApiError && (error.info.code === 'path_invalid' || error.info.code === 'conflict')
      ? error.info.message
      : undefined;
  const generalError =
    error && !pathError ? (error instanceof ApiError ? error.info.message : 'Something went wrong.') : undefined;
  const canSubmit = path.trim() !== '' && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) create.mutate();
  };

  return (
    <DialogContent
      title="New project"
      description="Add a folder on this computer. Chats in a project can read its files."
      width={480}
      returnFocusRef={modalReturnFocus}
      footer={
        <>
          <Button variant="ghost" disabled={create.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={create.isPending} disabled={!canSubmit}>
            Add project
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        {isElectron ? (
          <TextField
            label="Folder"
            value={path}
            readOnly
            placeholder="Choose a folder…"
            error={pathError}
            onClick={browse}
            inputClassName="cursor-pointer pr-24! truncate"
            trailing={
              <Button size="sm" onClick={browse}>
                Browse…
              </Button>
            }
          />
        ) : (
          <TextField
            label="Folder"
            value={path}
            onChange={(event) => changePath(event.target.value)}
            placeholder="/home/you/code/my-app"
            hint="Absolute path to the project folder. “~” is allowed."
            error={pathError}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        )}
        <TextField
          label="Name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameTouched(true);
          }}
          placeholder="Defaults to the folder name"
          autoComplete="off"
        />
        {generalError ? (
          <p role="alert" className="text-[13px] text-danger">
            {generalError}
          </p>
        ) : null}
      </form>
    </DialogContent>
  );
}
