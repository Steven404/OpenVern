import type { ChatSummary } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApiClient } from '../../lib/api-context';
import { queryKeys } from '../../lib/query-keys';
import { NEW_CHAT_PROJECT_PARAM, paths } from '../../lib/routes';
import { useRunsStore } from '../../stores/runs';
import { Composer, type ComposerSendInput } from '../composer/Composer';
import { resolveDefaultModel } from '../composer/models';
import { useModels, useProjects, useRunDeps, useSettings } from '../composer/queries';
import { ProjectChip } from './ProjectChip';

/** `#/new`: hero, new composer and the project chip. Preselects the project in `?project=<id>`. */
export function NewChatScreen() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const deps = useRunDeps();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const send = useRunsStore((s) => s.send);

  const projectsQuery = useProjects();
  const settings = useSettings();
  const modelsQuery = useModels();

  // The URL is the source of truth for the project, so "New chat here" and "Add project…" (which navigates to
  // `#/new?project=<id>`) both land on the right chip.
  const paramProject = params.get(NEW_CHAT_PROJECT_PARAM);
  const projects = projectsQuery.data ?? [];
  const known = paramProject !== null && projects.some((p) => p.id === paramProject);
  const projectId = paramProject !== null && (known || !projectsQuery.data) ? paramProject : null;

  // A project that is not in the (possibly stale) list yet, e.g. just created: refetch once.
  const refetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (paramProject && projectsQuery.data && !known && refetchedFor.current !== paramProject) {
      refetchedFor.current = paramProject;
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    }
  }, [paramProject, projectsQuery.data, known, queryClient]);

  const [picked, setPicked] = useState<string | null>(null);
  const model = picked ?? resolveDefaultModel(settings.data?.lastModel, modelsQuery.data);

  const onProjectChange = useCallback(
    (id: string | null) => {
      setParams(id ? { [NEW_CHAT_PROJECT_PARAM]: id } : {}, { replace: true });
    },
    [setParams],
  );

  const onSend = useCallback(
    async ({ text, attachments }: ComposerSendInput) => {
      const chat = await api.createChat({ projectId, model });
      const { messages: _messages, ...summary } = chat;
      queryClient.setQueryData(queryKeys.chat(chat.id), chat);
      queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (old) =>
        old ? [summary, ...old.filter((c) => c.id !== chat.id)] : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      // The run lives in the store, so it keeps going after this screen unmounts.
      navigate(paths.chat(chat.id));
      void send(deps, chat.id, { text, attachments, model });
    },
    [api, projectId, model, queryClient, navigate, send, deps],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-12 pb-[72px]">
      <div className="my-auto flex w-full max-w-[720px] flex-col gap-7">
        <h1 className="m-0 text-center font-display text-[44px] leading-[1.1] font-bold tracking-[-0.03em] text-text max-sm:text-[34px]">
          What are we building<span className="text-accent">?</span>
        </h1>
        <Composer
          variant="new"
          model={model}
          onModelChange={setPicked}
          projectId={projectId}
          onSend={onSend}
          autoFocus
          projectSlot={<ProjectChip projects={projects} value={projectId} onChange={onProjectChange} />}
        />
      </div>
    </div>
  );
}
