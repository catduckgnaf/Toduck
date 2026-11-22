import { useEffect, useRef, useState } from "react";
import { CategoryPicker, DateChooser, DetailPane, ProjectPicker, RepeatChooser, SectionLabel } from "@/components/toduck/ui";
import { Button } from "@/components/toduck/ui";
import {
  completionPatch,
  formatGroupLabel,
  formatWhen,
  nextOccurrence,
  normalizeRepeat,
  repeatLabel,
  shownDate,
  todayKey,
  type Category,
  type Project,
  type Repeat,
  type Task,
} from "@/lib/toduck/model";
import { useToduck } from "@/lib/toduck/store";
import { fetchMe, listUsers, type DirectoryUser, type ServerIdentity } from "@/lib/toduck/sync";

/**
 * Who owns this toduck and who it is shared with. Sharing is a server
 * feature: the directory and identity come from the connected server, and
 * changes save through the normal sync (the server re-stamps ownership and
 * only lets the owner change the sharing list).
 */
function SharingSection({ task }: { task: Task }) {
  const serverUrl = useToduck((s) => s.serverUrl);
  const serverToken = useToduck((s) => s.serverToken);
  const setTaskSharing = useToduck((s) => s.setTaskSharing);
  const [me, setMe] = useState<ServerIdentity | null>(null);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [failed, setFailed] = useState(false);
  const connected = !!serverUrl && !!serverToken;

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void (async () => {
      try {
        const [identity, users] = await Promise.all([fetchMe(serverUrl, serverToken), listUsers(serverUrl, serverToken)]);
        if (cancelled) return;
        setMe(identity);
        setDirectory(users);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, serverUrl, serverToken]);

  const sharedWith = task.sharedWith ?? [];
  const ownerName =
    task.ownerId === null
      ? null
      : me?.kind === "user" && me.id === task.ownerId
        ? "You"
        : (directory.find((user) => user.id === task.ownerId)?.name ?? "Another user");
  const canChangeSharing =
    !connected ||
    me === null ||
    me.kind === "admin" ||
    task.ownerId === null ||
    (me.kind === "user" && me.id === task.ownerId);

  return (
    <section className="mt-6">
      <SectionLabel>Sharing</SectionLabel>
      {!connected ? (
        <p className="mt-2 text-sm text-muted">
          Owner: {task.ownerId ? (ownerName ?? "—") : "— (not owned by a user)"}. Sharing needs a server connection —
          connect one in Settings, then share this toduck with other registered users.
        </p>
      ) : failed ? (
        <p className="mt-2 text-sm text-muted">Could not load the server's user list. Sharing can't be changed right now.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted">
            Owner: {task.ownerId ? (ownerName ?? "…") : "— (not owned by a user; the admin owns it)"}
            {sharedWith.length
              ? `. Shared with ${sharedWith.map((id) => directory.find((user) => user.id === id)?.name ?? "a user").join(", ")}.`
              : ". Not shared."}
          </p>
          {canChangeSharing ? (
            directory.filter((user) => user.id !== task.ownerId).length ? (
              <div className="mt-2 space-y-1">
                {directory
                  .filter((user) => user.id !== task.ownerId)
                  .map((user) => (
                    <label key={user.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        className="size-5 shrink-0 accent-[#1c1b19]"
                        checked={sharedWith.includes(user.id)}
                        onChange={(event) =>
                          setTaskSharing(
                            task.id,
                            event.target.checked ? [...sharedWith, user.id] : sharedWith.filter((id) => id !== user.id),
                          )
                        }
                      />
                      <span>
                        Share with {user.name}
                        {me?.kind === "user" && me.id === user.id ? " (you)" : ""}
                      </span>
                    </label>
                  ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">No other registered users on this server yet. The admin can create users in Settings.</p>
            )
          ) : (
            <p className="mt-2 text-sm text-muted">
              Shared with you by {ownerName ?? "the owner"}. You can edit this toduck, but only the owner can change
              sharing or delete it.
            </p>
          )}
        </>
      )}
    </section>
  );
}

type Draft = {
  title: string;
  notes: string;
  categoryId: string | null;
  projectId: string | null;
  date: string | null;
  repeat: Repeat;
};

export function Detail({
  taskId,
  triggerRef,
  onClose,
}: {
  taskId: string | null;
  /** The row button that opened the pane; focus returns to it on close. */
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  // The pane is rendered at the screen root, never inside a task row, so
  // it cannot unmount when the row filters out of the list (the shape of
  // #74). `shownId` keeps the last task around while the pane animates
  // closed: clearing the selection at once would unmount the dialog
  // mid-animation. The close timer only drops the selection after the
  // 200ms exit animation, and opening another task clears it first.
  const [shownId, setShownId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const task = useToduck((s) => (taskId ? s.tasks.find((item) => item.id === taskId && !item.deleted) : undefined));
  const shownTask = useToduck((s) =>
    shownId ? s.tasks.find((item) => item.id === shownId && !item.deleted) : undefined,
  );
  const categories = useToduck((s) => s.categories);
  const projects = useToduck((s) => s.projects);

  useEffect(() => {
    if (!taskId) return;
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setShownId(taskId);
    setOpen(true);
  }, [taskId]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  function requestClose() {
    setOpen(false);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(onClose, 250);
  }

  // The live task while open, so repeat and date changes underneath the
  // pane (completing a repeat advances it) reflect immediately; the last
  // shown task while closing, so the exit animation has content.
  const display = task ?? shownTask;
  if (!display) return null;
  return (
    <DetailBody
      key={display.id}
      task={display}
      categories={categories}
      projects={projects}
      open={open}
      triggerRef={triggerRef}
      onRequestClose={requestClose}
    />
  );
}

type PaneStatus = { key: number; text: string; undoable: boolean; noticeText?: string };

function DetailBody({
  task,
  categories,
  projects,
  open,
  triggerRef,
  onRequestClose,
}: {
  task: Task;
  categories: Category[];
  projects: Project[];
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  onRequestClose: () => void;
}) {
  const updateTask = useToduck((s) => s.updateTask);
  const deleteTask = useToduck((s) => s.deleteTask);
  const toggleTask = useToduck((s) => s.toggleTask);
  const undo = useToduck((s) => s.undo);
  // The store notice is the undo handle: its snapshot is what undo()
  // restores, and the notice bar auto-dismisses after 5s. The pane's Undo
  // is only offered while that notice is the one this status describes.
  const notice = useToduck((s) => s.notice);
  const addCategory = useToduck((s) => s.addCategory);
  const addProject = useToduck((s) => s.addProject);
  const today = todayKey();
  const visibleDate = shownDate(task, today);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [categoryId, setCategoryId] = useState(task.categoryId);
  const [projectId, setProjectId] = useState(task.projectId);
  const [date, setDate] = useState<string | null>(visibleDate);
  const [repeat, setRepeat] = useState<Repeat>(task.repeat);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [status, setStatus] = useState<PaneStatus | null>(null);
  const statusKey = useRef(0);
  const dateTouched = useRef(false);
  const saved = useRef<Draft>({
    title: task.title,
    notes: task.notes,
    categoryId: task.categoryId,
    projectId: task.projectId,
    date: task.date,
    repeat: normalizeRepeat(task.repeat),
  });
  const skipSave = useRef(false);
  const lastSeen = useRef({ date: task.date, repeat: task.repeat });
  const active = categories.filter((c) => !c.deleted).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const activeProjectList = projects.filter((p) => !p.deleted).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // The store task can move under the pane: completing a repeat advances
  // its date, and its row may leave the list at the same moment. The pane
  // stays open on the same task, so reflect the saved date and repeat —
  // otherwise the calendar would keep showing the old date. Title and
  // notes drafts are untouched: they only save on blur or close.
  useEffect(() => {
    if (
      task.date !== lastSeen.current.date ||
      JSON.stringify(task.repeat) !== JSON.stringify(lastSeen.current.repeat)
    ) {
      lastSeen.current = { date: task.date, repeat: task.repeat };
      setDate(shownDate(task, todayKey()));
      setRepeat(task.repeat);
      saved.current = { ...saved.current, date: task.date, repeat: normalizeRepeat(task.repeat) };
    }
  }, [task, task.date, task.repeat]);

  function showStatus(text: string, undoable = false, noticeText?: string) {
    statusKey.current += 1;
    setStatus({ key: statusKey.current, text, undoable, noticeText });
  }

  function changeRepeat(next: Repeat) {
    const rule = normalizeRepeat(next);
    save({ repeat: next });
    const anchor = date ?? task.date ?? today;
    const nextDate = rule.kind === "none" ? null : nextOccurrence(anchor, rule, anchor);
    showStatus(
      rule.kind === "none"
        ? "Doesn't repeat — checking this off finishes it."
        : nextDate
          ? `${repeatLabel(rule)} — next is ${formatGroupLabel(nextDate, today)}.`
          : `${repeatLabel(rule)} — set a date so the next one has somewhere to land.`,
    );
  }

  function toggleDone() {
    const todayNow = todayKey();
    const patch = completionPatch(task, todayNow, new Date().toISOString());
    const text =
      patch.advanced && patch.date
        ? `Moved to ${formatWhen(patch.date, todayNow)} — checking it off again moves it forward.`
        : patch.done
          ? "Completed."
          : "Restored — back on the list.";
    // The store notice text toggleTask is about to set (same inputs, same
    // wording): the pane's Undo is only live while that notice is current.
    const storeNoticeText =
      patch.advanced && patch.date
        ? `Moved repeating toduck to ${formatWhen(patch.date, todayNow)}`
        : patch.done
          ? "Completed"
          : "Restored";
    toggleTask(task.id);
    showStatus(text, true, storeNoticeText);
  }

  function save(overrides: Partial<Draft> = {}, notice?: string) {
    const next: Draft = {
      title,
      notes,
      categoryId,
      projectId,
      date: overrides.date !== undefined || dateTouched.current ? date : task.date,
      repeat,
      ...overrides,
    };
    const clean: Draft = {
      ...next,
      title: next.title.trim().slice(0, 200) || task.title,
      notes: next.notes.slice(0, 20_000),
      repeat: normalizeRepeat(next.repeat),
    };
    const previous = saved.current;
    if (
      clean.title === previous.title &&
      clean.notes === previous.notes &&
      clean.categoryId === previous.categoryId &&
      clean.projectId === previous.projectId &&
      clean.date === previous.date &&
      JSON.stringify(clean.repeat) === JSON.stringify(previous.repeat)
    ) {
      return;
    }
    saved.current = clean;
    setTitle(clean.title);
    setNotes(clean.notes);
    setCategoryId(clean.categoryId);
    setProjectId(clean.projectId);
    setDate(clean.date);
    setRepeat(clean.repeat);
    updateTask(task.id, clean, notice);
  }

  function close() {
    if (!skipSave.current) save();
    onRequestClose();
  }

  return (
    <DetailPane
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
      onCloseAutoFocus={(event) => {
        // Radix restores focus to its own Dialog.Trigger, which this pane
        // does not have — the opener is a row button. Send focus back
        // there when it is still on screen (the row may have filtered out
        // while the pane was open; then focus stays where it is).
        const trigger = triggerRef.current;
        if (trigger?.isConnected) {
          event.preventDefault();
          trigger.focus();
        }
      }}
      title="Details"
      description="Tag, project, notes, and schedule stay on this toduck."
    >
      <label className="sr-only" htmlFor="task-title">
        Toduck name
      </label>
      <input
        id="task-title"
        className="title-input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => save()}
        placeholder="Toduck name"
      />

      <section className="mt-6">
        <SectionLabel>Tag</SectionLabel>
        <div className="mt-2">
          <CategoryPicker
            categoryId={categoryId}
            categories={active}
            onChange={(id) => save({ categoryId: id })}
            onCreate={(name) => {
              const id = addCategory(name);
              if (id) save({ categoryId: id });
            }}
          />
        </div>
      </section>

      <section className="mt-6">
        <SectionLabel>Project</SectionLabel>
        <div className="mt-2">
          <ProjectPicker
            projectId={projectId}
            projects={activeProjectList}
            onChange={(id) => save({ projectId: id })}
            onCreate={(name) => {
              const id = addProject(name);
              if (id) save({ projectId: id });
            }}
          />
        </div>
      </section>

      <SharingSection task={task} />

      <section className="mt-6">
        <SectionLabel>Notes</SectionLabel>
        <textarea
          className="notes-area mt-2"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => save()}
          placeholder="Add the details you'll want later."
          aria-label="Notes"
        />
      </section>

      <section className="mt-6 border-t border-line pt-5">
        <SectionLabel>Schedule</SectionLabel>
        <div className="mt-2">
          <Button variant="quiet" onClick={toggleDone}>
            {task.done ? "Restore" : task.repeat.kind === "none" ? "Mark done" : "Done — move to next time"}
          </Button>
        </div>
        <div className="mt-3">
          <DateChooser
            date={date}
            calendarDefaultOpen
            onChange={(next) => {
              if (!next) return;
              dateTouched.current = true;
              const todayNow = todayKey();
              save({ date: next }, `Moved to ${formatWhen(next, todayNow)}`);
            }}
          />
        </div>
        <Button className="mt-3" variant="quiet" aria-expanded={repeatOpen} onClick={() => setRepeatOpen((open) => !open)}>
          {repeatOpen ? "Hide repeat" : repeat.kind === "none" ? "Doesn't repeat" : "Change repeat"}
        </Button>
        {repeatOpen ? (
          <div className="mt-3">
            <RepeatChooser repeat={repeat} date={date} onChange={changeRepeat} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">Only the next time shows on the list. Checking it off moves this toduck forward. Notes stay.</p>
        )}
        {status ? (
          <p
            key={status.key}
            role="status"
            className="repeat-flash mt-3 flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm text-ink"
          >
            <span>{status.text}</span>
            {status.undoable && notice?.text === status.noticeText ? (
              <Button
                variant="ghost"
                onClick={() => {
                  undo();
                  setStatus(null);
                }}
              >
                Undo
              </Button>
            ) : null}
          </p>
        ) : null}
      </section>

      <div className="mt-6 flex justify-end">
        <Button
          variant="danger"
          onClick={() => {
            skipSave.current = true;
            deleteTask(task.id);
            onRequestClose();
          }}
        >
          Delete toduck
        </Button>
      </div>
    </DetailPane>
  );
}
