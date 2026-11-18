import { DRAFT_CHAT_ID } from '@shared/constants';
import type { ChatSummary, EditMode, ReasoningEffort } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { resolveNewChatProject } from '../../app/queries';
import { useApiClient } from '../../lib/api-context';
import { queryKeys } from '../../lib/query-keys';
import { NEW_CHAT_PROJECT_PARAM, paths } from '../../lib/routes';
import { useRunsStore } from '../../stores/runs';
import { Composer, type ComposerSendInput } from '../composer/Composer';
import { resolveDefaultModel } from '../composer/models';
import { useModels, useProjects, useRunDeps, useSettings } from '../composer/queries';
import { RightPanelToggle } from '../right-panel';
import { DRAFT_PANEL_CHAT_ID, usePanelStore } from '../right-panel/panel-store';
import { adoptDraftTerminal } from '../terminal/adopt-draft';
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
  const { projectId, known } = resolveNewChatProject(paramProject, projectsQuery.data);

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
  // F3: a new chat starts from `lastEffort`, until the picker is used here.
  const [pickedEffort, setPickedEffort] = useState<ReasoningEffort | null | undefined>(undefined);
  const effort = pickedEffort === undefined ? (settings.data?.lastEffort ?? null) : pickedEffort;
  // INVARIANT: the chip resets to Review on every New chat open. A pick belongs to the navigation it was made in:
  // every navigation to this screen (a new open, "New chat here", a project change) gets a new location key, so an
  // Auto picked (and maybe warned about) for one project or one open never carries over.
  const { key: openKey } = useLocation();
  const [pickedMode, setPickedMode] = useState<{ openKey: string; mode: EditMode } | null>(null);
  const editMode: EditMode = pickedMode?.openKey === openKey ? pickedMode.mode : 'review';
  const onEditModeChange = useCallback((mode: EditMode) => setPickedMode({ openKey, mode }), [openKey]);
  // Only a mode the chip offered is sent: it is hidden in a loose chat and for a model without tools.
  const toolsModel = modelsQuery.data?.find((m) => m.id === model)?.supportsTools === true;
  const createMode: EditMode = projectId !== null && toolsModel ? editMode : 'review';

  const onProjectChange = useCallback(
    (id: string | null) => {
      setParams(id ? { [NEW_CHAT_PROJECT_PARAM]: id } : {}, { replace: true });
    },
    [setParams],
  );

  const onSend = useCallback(
    async ({ text, attachments }: ComposerSendInput) => {
      const chat = await api.createChat({ projectId, model, editMode: createMode });
      const { messages: _messages, ...summary } = chat;
      queryClient.setQueryData(queryKeys.chat(chat.id), chat);
      queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (old) =>
        old ? [summary, ...old.filter((c) => c.id !== chat.id)] : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      // A terminal opened here moves into the chat before the first run, so the model can read it (and the chat shows
      // it). Never throws, and does nothing without the desktop bridge.
      await adoptDraftTerminal(chat.id);
      // The panel's tabs follow the draft into the new chat, so the next New chat starts clean.
      usePanelStore.getState().moveChat(DRAFT_PANEL_CHAT_ID, chat.id);
      // The run lives in the store, so it keeps going after this screen unmounts.
      navigate(paths.chat(chat.id));
      void send(deps, chat.id, { text, attachments, model, effort });
    },
    [api, projectId, model, createMode, effort, queryClient, navigate, send, deps],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-(--height-header) shrink-0 items-center justify-end pr-3">
        <RightPanelToggle />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scrollbar-stable-centered pl-6 pb-[72px]">
        <div className="my-auto flex w-full max-w-[720px] flex-col gap-7">
          <h1 className="m-0 text-center font-display text-[44px] leading-[1.1] font-bold tracking-[-0.03em] text-text max-sm:text-[34px]">
            What are we building?
          </h1>
          <Composer
            variant="new"
            model={model}
            onModelChange={setPicked}
            effort={effort}
            onEffortChange={setPickedEffort}
            projectId={projectId}
            onSend={onSend}
            autoFocus
            sinkKey={DRAFT_CHAT_ID}
            editMode={editMode}
            onEditModeChange={onEditModeChange}
            projectSlot={<ProjectChip projects={projects} value={projectId} onChange={onProjectChange} />}
          />
        </div>
      </div>
    </div>
  );
}
