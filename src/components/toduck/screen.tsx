import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Menu, Settings, X } from "lucide-react";
import { Detail } from "@/components/toduck/detail";
import { CategoriesDialog, ProjectsDialog, SettingsDialog } from "@/components/toduck/settings";
import { Button, CategoryPicker, Chip, Modal, ProjectPicker, RepeatChooser } from "@/components/toduck/ui";
import {
  activeCategories,
  activeProjects,
  addDays,
  buildGroups,
  buildWorkflow,
  categoryName,
  countFor,
  dateHorizon,
  DATE_PRESETS,
  formatWhen,
  monthDay,
  presetDate,
  projectName,
  repeatLabel,
  requireDate,
  shownDate,
  startOfWeek,
  todayKey,
  weekdayName,
  DAY_SHORT,
  type Horizon,
  type Project,
  type Repeat,
  type Task,
  type ViewId,
} from "@/lib/toduck/model";
import { bindSync, syncNow, useToduck } from "@/lib/toduck/store";
import {
  formatTimeLabel,
  parseNaturalLanguage,
  parsedNoteLines,
  type Ambiguity,
  type Priority,
  type Suggestion,
  type SuggestionApply,
  type SuggestionOption,
} from "@/lib/toduck/natural-language";

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "all", label: "All Tasks" },
  { id: "feed", label: "Feed" },
  { id: "day", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "overdue", label: "Overdue" },
  { id: "repeats", label: "Repeats" },
  { id: "done", label: "Done" },
  { id: "workflow", label: "Workflow" },
  { id: "projects", label: "Projects" },
];

export function ToduckShell() {
  return (
    <div className="mx-auto flex h-dvh w-full max-w-6xl flex-col bg-paper px-5 pt-8">
      <div className="h-4 w-20 rounded-full bg-paper-2" />
      <div className="mt-4 h-10 w-48 rounded-xl bg-paper-2" />
      <div className="mt-8 h-24 rounded-2xl bg-card" />
      <div className="mt-3 h-24 rounded-2xl bg-card" />
    </div>
  );
}

export function ToduckScreen() {
  const state = useToduck();
  const [detailId, setDetailId] = useState<string | null>(null);
  // The row button that opened the details pane; focus returns to it when
  // the pane closes (the pane has no Radix Trigger of its own).
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [projectsManageOpen, setProjectsManageOpen] = useState(false);
  // The menu is pinned open by default on wide screens, as a real column
  // beside the inbox. On small screens it starts closed and opens as a
  // drawer over the inbox instead.
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 768);

  useEffect(() => {
    const unsub = bindSync();
    void syncNow();
    return unsub;
  }, []);

  useEffect(() => {
    if (!state.notice) return;
    // The details pane covers the notice bar, and its Undo is the notice's
    // undo — so the 5s dismissal waits until the pane closes instead of
    // expiring the undo while the pane is open.
    if (detailId) return;
    const id = window.setTimeout(() => state.dismissNotice(), 5000);
    return () => window.clearTimeout(id);
  }, [state.notice, state.dismissNotice, detailId]);

  const today = todayKey();
  const focus = state.focusDate || today;
  const refine = {
    query: state.query,
    categoryId: state.categoryFilter,
    projectId: state.projectFilter,
    showRepeating: state.showRepeating,
  };
  const groups = buildGroups(state.tasks, state.categories, state.view, focus, today, refine, state.projects);
  const workflow = state.view === "workflow" ? buildWorkflow(state.tasks, state.categories, focus, today, refine, state.projects) : [];
  const categories = activeCategories(state.categories);
  const projects = activeProjects(state.projects);
  const filtering =
    state.query.trim().length > 0 || !!state.categoryFilter || !!state.projectFilter || !state.showRepeating;
  const overdueCount = countFor(state.tasks, state.categories, "overdue", focus, today, refine, state.projects);
  const header = headerCopy(state.view, focus, today);
  const viewCount = countFor(state.tasks, state.categories, state.view, focus, today, refine, state.projects);
  const headerCount = state.view === "projects" && !state.projectFilter ? projects.length : viewCount;
  const countWord =
    state.view === "done"
      ? "finished toducks"
      : state.view === "all" || state.view === "workflow"
        ? "toducks"
        : state.view === "projects" && !state.projectFilter
          ? "projects"
          : "open toducks";
  const selectedProject = state.projectFilter ? projects.find((p) => p.id === state.projectFilter) : undefined;

  function toggleSidebar() {
    setSidebarOpen((open) => !open);
  }

  function navigate(view: ViewId) {
    if (view === "projects") state.setProjectFilter(null);
    state.setView(view);
    // The pinned desktop menu stays open; only the small-screen drawer
    // closes after a choice.
    if (typeof window !== "undefined" && window.innerWidth < 768) setSidebarOpen(false);
  }

  function renderGroups() {
    if (groups.length === 0) {
      return <Empty view={state.view} filtering={filtering} onClear={state.clearFilters} />;
    }
    return groups.map((group) => (
      <section key={group.key}>
        {group.label ? (
          <h2 className={`border-l-2 px-4 font-display text-lg ${horizonClass(groupHorizon(group.key, today))} ${state.compact ? "pt-2" : "pt-3"}`}>
            {group.label}
          </h2>
        ) : null}
        <ul>
          {group.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              category={categoryName(state.categories, task.categoryId)}
              project={projectName(state.projects, task.projectId)}
              today={today}
              compact={state.compact}
              onOpen={(trigger) => {
                detailTriggerRef.current = trigger;
                setDetailId(task.id);
              }}
            />
          ))}
        </ul>
      </section>
    ));
  }

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-paper text-ink">
      <header className="shrink-0 px-3 pt-3 md:px-5 md:pt-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="grid size-10 shrink-0 place-items-center rounded-full text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            aria-label="Toggle navigation"
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
          >
            <Menu className="size-5" />
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-2xl text-ink md:text-4xl">{header.title}</h1>
            <p className="text-sm text-muted">
              {header.sub}
              <span className="tabular-nums"> · {headerCount} {countWord}</span>
            </p>
          </div>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      {sidebarOpen ? (
        <aside className="absolute inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col border-r border-line bg-paper shadow-2xl md:static md:z-auto md:shadow-none" aria-label="Sidebar">
          <div className="flex items-center gap-3 px-4 pt-5">
            <img src="/logo.png" alt="" className="size-11 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <p className="font-display text-xl leading-tight text-ink">Toduck</p>
              <p className="text-xs text-muted">Your toducks</p>
            </div>
            <button
              type="button"
              className="grid size-11 shrink-0 place-items-center rounded-full text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              aria-label="Close navigation"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
            <nav aria-label="Views" className="mt-5 flex flex-col gap-1">
              {VIEWS.map((view) => {
                const active = state.view === view.id;
                const count =
                  view.id === "projects"
                    ? projects.length
                    : countFor(
                        state.tasks,
                        state.categories,
                        view.id,
                        view.id === "day" ? focus : today,
                        today,
                        refine,
                        state.projects,
                      );
                const label = view.id === "day" ? (focus === today ? "Today" : formatWhen(focus, today)) : view.label;
                return (
                  <button
                    key={view.id}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => navigate(view.id)}
                    className={`flex min-h-11 items-center justify-between gap-2 rounded-xl px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                      active ? "bg-ink text-paper" : "text-ink hover:bg-paper-2"
                    }`}
                  >
                    <span>{label}</span>
                    <span className="tabular-nums">{count}</span>
                  </button>
                );
              })}
            </nav>

            <div className="mt-5">
              <input
                className="field"
                type="search"
                value={state.query}
                onChange={(event) => state.setQuery(event.target.value)}
                placeholder="Filter toducks"
                aria-label="Filter toducks"
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Chip active={!state.categoryFilter} onClick={() => state.setCategoryFilter(null)}>
                All
              </Chip>
              {categories.map((category) => (
                <Chip
                  key={category.id}
                  active={state.categoryFilter === category.id}
                  onClick={() => state.setCategoryFilter(state.categoryFilter === category.id ? null : category.id)}
                >
                  {category.name}
                </Chip>
              ))}
              {filtering ? (
                <Button variant="ghost" onClick={state.clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {state.view !== "repeats" ? (
                <Chip active={!state.showRepeating} aria-pressed={!state.showRepeating} onClick={() => state.setShowRepeating(!state.showRepeating)}>
                  {state.showRepeating ? "Hide repeats" : "Repeats hidden"}
                </Chip>
              ) : null}
              <Chip active={state.compact} aria-pressed={state.compact} onClick={() => state.setCompact(!state.compact)}>
                {state.compact ? "Compact on" : "Compact"}
              </Chip>
            </div>

            <div className="mt-5 flex flex-col gap-2">
              <Button variant="quiet" className="w-full" onClick={() => setCategoriesOpen(true)}>
                Tags
              </Button>
              <button
                type="button"
                className="relative inline-flex min-h-11 w-full items-center justify-center rounded-full bg-paper-2 px-4 text-sm font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings className="mr-2 size-5" />
                Settings
                {state.serverUrl ? (
                  <span
                    className={`absolute right-3 top-1/2 size-2 -translate-y-1/2 rounded-full ${state.syncStatus === "error" ? "bg-danger" : "bg-sage"}`}
                  />
                ) : null}
              </button>
            </div>
          </div>
        </aside>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {state.view === "day" ? (
          <WeekStrip
            focus={focus}
            today={today}
            tasks={state.tasks}
            categoryFilter={state.categoryFilter}
            projectFilter={state.projectFilter}
            showRepeating={state.showRepeating}
            onSelect={state.setFocusDate}
          />
        ) : null}

        {state.view === "day" && focus === today && overdueCount > 0 ? (
          <div className="shrink-0 px-5 pb-3">
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between rounded-2xl bg-danger-soft px-4 text-sm font-medium text-danger"
              onClick={() => state.setView("overdue")}
            >
              <span className="tabular-nums">{overdueCount} overdue</span>
              <span>Show</span>
            </button>
          </div>
        ) : null}

        <main className="min-h-0 flex-1 overflow-y-auto pb-4">
          {state.view === "workflow" ? (
            workflow.every((column) => column.tasks.length === 0) ? (
              <Empty view="workflow" filtering={filtering} onClear={state.clearFilters} />
            ) : (
              <div className="flex gap-3 overflow-x-auto px-5 pb-2 pt-2">
                {workflow.map((column) => (
                  <section key={column.id} className="w-72 shrink-0 rounded-2xl bg-card p-2" aria-label={column.label}>
                    <h2 className={`px-2 pt-2 font-display text-xl text-ink ${column.id === "overdue" ? "text-danger" : ""}`}>
                      {column.label}
                      <span className="ml-2 text-sm tabular-nums text-muted">{column.tasks.length}</span>
                    </h2>
                    {column.tasks.length === 0 ? (
                      <p className="px-2 py-4 text-sm text-muted">Nothing here.</p>
                    ) : (
                      <ul>
                        {column.tasks.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            category={categoryName(state.categories, task.categoryId)}
                            project={projectName(state.projects, task.projectId)}
                            today={today}
                            compact={state.compact}
                            onOpen={(trigger) => {
                              detailTriggerRef.current = trigger;
                              setDetailId(task.id);
                            }}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            )
          ) : state.view === "projects" && !state.projectFilter ? (
            <ProjectsList
              projects={projects}
              tasks={state.tasks}
              onSelect={(id) => state.setProjectFilter(id)}
              onManage={() => setProjectsManageOpen(true)}
            />
          ) : (
            <>
              {state.view === "projects" && state.projectFilter ? (
                <div className="flex items-center gap-2 px-5 pt-4">
                  <Button variant="ghost" onClick={() => state.setProjectFilter(null)}>
                    ← All projects
                  </Button>
                  <p className="font-display text-2xl text-ink">{selectedProject?.name ?? "Project"}</p>
                </div>
              ) : null}
              {renderGroups()}
            </>
          )}
        </main>

        {state.notice ? (
          <div className="shrink-0 px-5">
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-paper-2 px-4 py-1">
              <p className="text-sm">{state.notice.text}</p>
              <Button variant="ghost" onClick={state.undo}>
                Undo
              </Button>
            </div>
          </div>
        ) : null}

        <Composer view={state.view} focus={focus} categoryFilter={state.categoryFilter} projectFilter={state.projectFilter} />
      </div>

        <Detail taskId={detailId} triggerRef={detailTriggerRef} onClose={() => setDetailId(null)} />
        {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
        {categoriesOpen ? <CategoriesDialog onClose={() => setCategoriesOpen(false)} /> : null}
        {projectsManageOpen ? <ProjectsDialog onClose={() => setProjectsManageOpen(false)} /> : null}
      </div>
    </div>
  );
}

function ProjectsList({
  projects,
  tasks,
  onSelect,
  onManage,
}: {
  projects: Project[];
  tasks: Task[];
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const addProject = useToduck((s) => s.addProject);
  const [name, setName] = useState("");
  return (
    <div className="px-5 pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Pick a project to see its toducks.</p>
        <Button variant="quiet" onClick={onManage}>
          Manage projects
        </Button>
      </div>
      {projects.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">No projects yet. Create one below, then put toducks in it.</p>
      ) : (
        <ul className="mt-3">
          {projects.map((project) => {
            const open = tasks.filter((task) => !task.deleted && !task.done && task.projectId === project.id).length;
            const total = tasks.filter((task) => !task.deleted && task.projectId === project.id).length;
            return (
              <li key={project.id} className="border-b border-line">
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-2 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  onClick={() => onSelect(project.id)}
                  aria-label={`Show toducks in ${project.name}`}
                >
                  <span className="font-medium text-ink">{project.name}</span>
                  <span className="text-sm tabular-nums text-muted">
                    {open} open · {total} total
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (addProject(name)) setName("");
        }}
      >
        <input
          className="field"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New project"
          aria-label="New project"
          maxLength={40}
        />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}

function headerCopy(view: ViewId, focus: string, today: string): { title: string; sub: string } {
  if (view === "day") {
    const when =
      focus === today ? "Today" : focus === addDays(today, 1) ? "Tomorrow" : focus === addDays(today, -1) ? "Yesterday" : "";
    return { title: weekdayName(focus), sub: [monthDay(focus), when].filter(Boolean).join(" · ") };
  }
  const copy: Record<Exclude<ViewId, "day">, { title: string; sub: string }> = {
    all: { title: "All Tasks", sub: "Every toduck, open and finished" },
    feed: { title: "Feed", sub: "Every open toduck, each repeat only once" },
    upcoming: { title: "Upcoming", sub: "Dated after today" },
    overdue: { title: "Overdue", sub: "Still open from earlier days" },
    later: { title: "Feed", sub: "Every open toduck, each repeat only once" },
    repeats: { title: "Repeats", sub: "Each one shows only its next time" },
    done: { title: "Done", sub: "One-time toducks you finished" },
    workflow: { title: "Workflow", sub: "Toducks in the column their date puts them in" },
    projects: { title: "Projects", sub: "Toducks grouped by the project they belong to" },
  };
  return copy[view];
}

function WeekStrip({
  focus,
  today,
  tasks,
  categoryFilter,
  projectFilter,
  showRepeating,
  onSelect,
}: {
  focus: string;
  today: string;
  tasks: Task[];
  categoryFilter: string | null;
  projectFilter: string | null;
  showRepeating: boolean;
  onSelect: (date: string) => void;
}) {
  const start = startOfWeek(focus);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  return (
    <div className="flex shrink-0 items-center gap-1 px-3 pb-3">
      <button
        type="button"
        className="grid size-11 shrink-0 place-items-center rounded-full text-ink"
        aria-label="Previous week"
        onClick={() => onSelect(addDays(focus, -7))}
      >
        <ChevronLeft className="size-5" />
      </button>
      <div className="grid min-w-0 flex-1 grid-cols-7 gap-1">
        {days.map((day) => {
          const selected = day === focus;
          const count = tasks.filter((task) => {
            if (task.deleted || task.done || shownDate(task, today) !== day) return false;
            if (categoryFilter && task.categoryId !== categoryFilter) return false;
            if (projectFilter && task.projectId !== projectFilter) return false;
            if (!showRepeating && task.repeat.kind !== "none") return false;
            return true;
          }).length;
          return (
            <button
              key={day}
              type="button"
              aria-pressed={selected}
              aria-label={formatWhen(day, today)}
              className={`flex min-h-11 flex-col items-center justify-center rounded-2xl text-ink ${selected ? "bg-ink text-paper" : day === today ? "bg-paper-2" : ""}`}
              onClick={() => onSelect(day)}
            >
              <span className={`text-xs ${selected ? "text-paper" : "text-muted"}`}>{DAY_SHORT[new Date(`${day}T12:00:00`).getDay()]}</span>
              <span className="text-sm font-medium tabular-nums">{Number(day.slice(-2))}</span>
              <span className={`mt-0.5 size-1 rounded-full ${count ? (selected ? "bg-paper" : "bg-ink") : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="grid size-11 shrink-0 place-items-center rounded-full text-ink"
        aria-label="Next week"
        onClick={() => onSelect(addDays(focus, 7))}
      >
        <ChevronRight className="size-5" />
      </button>
    </div>
  );
}


const HORIZON_TEXT: Record<Horizon, string> = {
  overdue: "text-horizon-overdue",
  tomorrow: "text-horizon-tomorrow",
  "this-week": "text-horizon-this-week",
  "next-week": "text-horizon-next-week",
  "next-month": "text-horizon-next-month",
  future: "text-horizon-future",
};

function horizonClass(horizon: Horizon): string {
  return HORIZON_TEXT[horizon];
}

function groupHorizon(key: string, today: string): Horizon {
  if (key === "overdue") return "overdue";
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return dateHorizon(key, today);
  return "this-week";
}

function TaskRow({
  task,
  category,
  project,
  today,
  compact,
  onOpen,
}: {
  task: Task;
  category: string | null;
  project: string | null;
  today: string;
  compact: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  const moveTask = useToduck((s) => s.moveTask);
  const toggleTask = useToduck((s) => s.toggleTask);
  const updateTask = useToduck((s) => s.updateTask);
  const addCategory = useToduck((s) => s.addCategory);
  const addProject = useToduck((s) => s.addProject);
  const allCategories = useToduck((s) => s.categories);
  const allProjects = useToduck((s) => s.projects);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const when = requireDate(shownDate(task, today), today);
  const horizon = dateHorizon(when, today);

  return (
    <li className="border-b border-line px-3 md:px-4">
      <div className="flex items-center gap-2 py-1.5">
        <button
          type="button"
          role="checkbox"
          aria-checked={task.done}
          aria-label={task.repeat.kind === "none" ? `Complete ${task.title}` : `Done. Move ${task.title} to the next time`}
          className="grid size-9 shrink-0 place-items-center"
          onClick={() => toggleTask(task.id)}
        >
          <span className={`grid size-4 place-items-center rounded-full border border-ink text-[10px] text-paper ${task.done ? "bg-ink" : "bg-transparent"}`}>
            {task.done ? "✓" : ""}
          </span>
        </button>
        <div className="min-w-0 flex-1 py-0.5 text-left">
          <div className="flex min-w-0 items-baseline gap-2">
            <button
              type="button"
              className="min-w-0 flex-[0_1_auto] truncate text-left"
              onClick={(event) => onOpen(event.currentTarget)}
              aria-label={`Details for ${task.title}`}
            >
              <span className={`block truncate text-sm font-medium ${task.done ? "text-muted line-through" : "text-ink"}`}>{task.title}</span>
            </button>
            <div className={`relative shrink-0 rounded px-1 py-0.5 text-xs font-medium tabular-nums whitespace-nowrap ${horizonClass(horizon)}`}>
              <span aria-hidden="true">{formatWhen(when, today)}</span>
              <input
                type="date"
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label={`Change date for ${task.title}, currently ${formatWhen(when, today)}`}
                value={when}
                onClick={(event) => {
                  try {
                    event.currentTarget.showPicker();
                  } catch {
                    // Some browsers already open the picker from the click itself.
                  }
                }}
                onChange={(event) => {
                  if (event.target.value) moveTask(task.id, event.target.value);
                }}
              />
            </div>
          </div>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className={category ? "max-w-[8rem] truncate rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none" : "shrink-0 text-[11px] text-faint"}
              style={category ? { color: categoryTone(category), background: "rgb(255 255 255 / 0.06)" } : undefined}
              aria-label={`Change tag for ${task.title}`}
              onClick={(event) => {
                event.stopPropagation();
                setCategoryOpen(true);
              }}
            >
              {category ?? "Add tag"}
            </button>
            <button
              type="button"
              className={project ? "max-w-[8rem] truncate text-[11px] text-muted" : "shrink-0 text-[11px] text-faint"}
              aria-label={`Change project for ${task.title}`}
              onClick={(event) => {
                event.stopPropagation();
                setProjectOpen(true);
              }}
            >
              {project ?? "Add project"}
            </button>
            <button
              type="button"
              className="shrink-0 text-[11px] text-muted"
              aria-label={`Change repeat for ${task.title}`}
              onClick={(event) => {
                event.stopPropagation();
                setRepeatOpen(true);
              }}
            >
              {repeatLabel(task.repeat, "short")}
            </button>
          </span>
          {!compact && notePreviewSafe(task.notes) ? (
            <span className="mt-0.5 hidden truncate text-xs text-faint md:block">{notePreviewSafe(task.notes)}</span>
          ) : null}
        </div>
      </div>
      {projectOpen ? (
        <Modal open onOpenChange={setProjectOpen} title="Project" description={task.title}>
          <ProjectPicker
            projectId={task.projectId}
            projects={activeProjects(allProjects)}
            onChange={(id) => {
              updateTask(task.id, { projectId: id });
              setProjectOpen(false);
            }}
            onCreate={(name) => {
              const id = addProject(name);
              if (id) updateTask(task.id, { projectId: id });
              setProjectOpen(false);
            }}
          />
        </Modal>
      ) : null}
      {repeatOpen ? (
        <Modal open onOpenChange={setRepeatOpen} title="Repeat" description={task.title}>
          <RepeatChooser repeat={task.repeat} date={task.date} onChange={(next) => updateTask(task.id, { repeat: next })} />
          <Button className="mt-3" variant="quiet" onClick={() => setRepeatOpen(false)}>
            Done
          </Button>
        </Modal>
      ) : null}
      {categoryOpen ? (
        <Modal open onOpenChange={setCategoryOpen} title="Tag" description={task.title}>
          <CategoryPicker
            categoryId={task.categoryId}
            categories={activeCategories(allCategories)}
            onChange={(id) => {
              updateTask(task.id, { categoryId: id });
              setCategoryOpen(false);
            }}
            onCreate={(name) => {
              const id = addCategory(name);
              if (id) updateTask(task.id, { categoryId: id });
              setCategoryOpen(false);
            }}
          />
        </Modal>
      ) : null}
    </li>
  );
}

function notePreviewSafe(notes: string): string {
  const line = notes.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function categoryTone(name: string): string {
  const tones = ["#d7c4a3", "#9dceb4", "#e0b1a8", "#a9bddb", "#e0d09a", "#cbb4dd"];
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % tones.length;
  return tones[hash] ?? tones[0];
}

function Empty({ view, filtering, onClear }: { view: ViewId; filtering: boolean; onClear: () => void }) {
  if (filtering) {
    return (
      <div className="px-5 py-16 text-center">
        <p className="font-display text-2xl text-ink">Nothing matches</p>
        <p className="mt-2 text-sm text-muted">Those filters are hiding every toduck.</p>
        <Button className="mt-4" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    );
  }
  const copy: Record<ViewId, { title: string; body: string }> = {
    all: { title: "No toducks yet", body: "Every toduck you add, open or finished, gathers here exactly once." },
    feed: { title: "The feed is empty", body: "Every open toduck lives here, one row each. A repeat stays on its next date until you check it off." },
    day: { title: "Nothing on this day", body: "Add a toduck below. Every toduck has a date." },
    upcoming: { title: "Nothing upcoming", body: "Toducks with a future date gather here." },
    overdue: { title: "Nothing overdue", body: "Anything still open from an earlier day shows up here." },
    later: { title: "The feed is empty", body: "Every open toduck lives here, one row each." },
    repeats: { title: "No repeating toducks", body: "A repeat shows up once, on its next date. Checking it off moves that same toduck forward." },
    done: { title: "Nothing finished", body: "One-time toducks you check off land here. Repeats schedule their next date instead." },
    workflow: { title: "Nothing on the board", body: "Toducks land in a column by their date: overdue, today, upcoming, or done." },
    projects: { title: "Nothing in this project", body: "Toducks assigned to this project show up here, open and finished." },
  };
  return (
    <div className="px-5 py-16 text-center">
      <p className="font-display text-2xl text-ink">{copy[view].title}</p>
      <p className="mt-2 text-sm text-pretty text-muted">{copy[view].body}</p>
    </div>
  );
}

function Composer({
  view,
  focus,
  categoryFilter,
  projectFilter,
}: {
  view: ViewId;
  focus: string;
  categoryFilter: string | null;
  projectFilter: string | null;
}) {
  // Memoize the active lists: activeCategories/activeProjects build a
  // fresh array on every call, and the parse memo below must only
  // recompute when the underlying store data changes - otherwise the
  // sync effect below re-runs on every render.
  const rawCategories = useToduck((s) => s.categories);
  const rawProjects = useToduck((s) => s.projects);
  const categories = useMemo(() => activeCategories(rawCategories), [rawCategories]);
  const projects = useMemo(() => activeProjects(rawProjects), [rawProjects]);
  const addTask = useToduck((s) => s.addTask);
  const today = todayKey();
  const defaultDate = view === "upcoming" ? addDays(today, 1) : view === "day" ? focus : today;
  // The composer offers the preset repeats; custom intervals and chosen
  // days are set from a toduck's details.
  type SimpleRepeatKind = "none" | "daily" | "weekdays" | "weekly" | "monthly";
  const defaultRepeatKind: SimpleRepeatKind = view === "repeats" ? "daily" : "none";
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState<string>(defaultDate);
  const [repeatKind, setRepeatKind] = useState<SimpleRepeatKind>(defaultRepeatKind);
  const [categoryId, setCategoryId] = useState<string | null>(categoryFilter);
  const [projectId, setProjectId] = useState<string | null>(projectFilter);
  // Natural-language state: the parsed repeat when it is richer than
  // the simple kinds the select offers, plus a time and a priority,
  // which the task model has no fields for. The parsed date, project
  // and tag sync straight into the composer's own controls below.
  const [repeatOverride, setRepeatOverride] = useState<Repeat | null>(null);
  const [nlTime, setNlTime] = useState<string | null>(null);
  const [nlPriority, setNlPriority] = useState<Priority | null>(null);
  const [ignoreParse, setIgnoreParse] = useState(false);
  // Ambiguity spans the user resolved by picking a reading: the text
  // was never consumed by the parser, so it is stripped from the
  // saved title only once the user has said what it means.
  const [resolvedSpans, setResolvedSpans] = useState<string[]>([]);

  useEffect(() => {
    setDate(defaultDate);
    setCategoryId(categoryFilter);
    setProjectId(projectFilter);
  }, [defaultDate, categoryFilter, projectFilter]);

  // What the task name means right now. Typing re-parses on every
  // keystroke; the preview below shows the result before anything is
  // saved.
  const parsed = useMemo(
    () => parseNaturalLanguage(title, { now: new Date(), projects, categories }),
    [title, projects, categories],
  );
  const hasParse =
    parsed.date !== null ||
    parsed.time !== null ||
    parsed.repeat.kind !== "none" ||
    parsed.projectId !== null ||
    parsed.categoryId !== null ||
    parsed.priority !== null ||
    parsed.suggestions.length > 0 ||
    parsed.ambiguities.length > 0;
  // The cleaned title is what Add saves (unless parsing is ignored).
  // Ambiguity spans the user resolved are stripped from it: the user
  // has said what they mean, so the raw text no longer needs to stay.
  const cleanTitle = ignoreParse
    ? title.trim()
    : resolvedSpans
        .reduce((text, span) => text.replace(span, ""), parsed.title)
        .replace(/\s+/g, " ")
        .trim();

  const applyRepeat = (repeat: Repeat): void => {
    if (
      repeat.kind === "none" ||
      repeat.kind === "daily" ||
      repeat.kind === "weekdays" ||
      repeat.kind === "weekly" ||
      repeat.kind === "monthly"
    ) {
      setRepeatKind(repeat.kind);
      setRepeatOverride(null);
    } else {
      setRepeatOverride(repeat);
    }
  };

  // Sync the parse into the composer's controls, one field at a time:
  // a field is only written when the text changes what it means, so a
  // manual edit (or a reverted suggestion) sticks until the text
  // itself says something different. A parsed value of null means the
  // text says nothing about that field, so the control is left alone.
  const lastSyncedRef = useRef<{
    date: string | null;
    repeat: Repeat;
    projectId: string | null;
    categoryId: string | null;
    time: string | null;
    priority: Priority | null;
  } | null>(null);
  useEffect(() => {
    setIgnoreParse(false);
    // Only clear when something was resolved: a fresh array is never
    // referentially equal, so an unconditional set would re-render
    // on every parse change for nothing.
    setResolvedSpans((prev) => (prev.length === 0 ? prev : []));
    const prev = lastSyncedRef.current;
    const sameRepeat = prev !== null && JSON.stringify(prev.repeat) === JSON.stringify(parsed.repeat);
    if ((!prev || prev.date !== parsed.date) && parsed.date !== null) setDate(parsed.date);
    if (!sameRepeat && parsed.repeat.kind !== "none") applyRepeat(parsed.repeat);
    if ((!prev || prev.projectId !== parsed.projectId) && parsed.projectId !== null) {
      setProjectId(parsed.projectId);
    }
    if ((!prev || prev.categoryId !== parsed.categoryId) && parsed.categoryId !== null) {
      setCategoryId(parsed.categoryId);
    }
    if ((!prev || prev.time !== parsed.time) && parsed.time !== null) setNlTime(parsed.time);
    if ((!prev || prev.priority !== parsed.priority) && parsed.priority !== null) {
      setNlPriority(parsed.priority);
    }
    lastSyncedRef.current = {
      date: parsed.date,
      repeat: parsed.repeat,
      projectId: parsed.projectId,
      categoryId: parsed.categoryId,
      time: parsed.time,
      priority: parsed.priority,
    };
    // The parse is the only input: it changes exactly when the text does.
  }, [parsed]);

  const applyOption = (apply: SuggestionApply): void => {
    switch (apply.field) {
      case "date":
        setDate(apply.date);
        break;
      case "time":
        setNlTime(apply.time);
        break;
      case "repeat":
        applyRepeat(apply.repeat);
        break;
      case "projectId":
        setProjectId(apply.projectId);
        break;
      case "categoryId":
        setCategoryId(apply.categoryId);
        break;
      case "priority":
        setNlPriority(apply.priority);
        break;
    }
  };

  // A fuzzy pick-list only sets the field once the user picks a reading.
  // Resolve the original typo at the same time so it leaves the saved title.
  const applySuggestionOption = (suggestion: Suggestion, option: SuggestionOption): void => {
    applyOption(option.apply);
    setResolvedSpans((prev) => [...prev, suggestion.source]);
  };

  // Picking an ambiguity reading also resolves its raw text: it leaves
  // the saved title, since the user has said what it means.
  const applyAmbiguity = (ambiguity: Ambiguity, reading: SuggestionOption): void => {
    applyOption(reading.apply);
    setResolvedSpans((prev) => [...prev, ambiguity.text]);
  };

  // Undo a direct (single clear answer) suggestion: the field goes
  // back to the composer's default, and the sync above does not
  // re-apply it because the text still means the same thing.
  const revertSuggestion = (suggestion: Suggestion): void => {
    const apply = suggestion.apply;
    if (!apply) return;
    switch (apply.field) {
      case "date":
        setDate(defaultDate);
        break;
      case "time":
        setNlTime(null);
        break;
      case "repeat":
        setRepeatKind(defaultRepeatKind);
        setRepeatOverride(null);
        break;
      case "projectId":
        setProjectId(projectFilter);
        break;
      case "categoryId":
        setCategoryId(categoryFilter);
        break;
      case "priority":
        setNlPriority(null);
        break;
    }
  };

  // "Ignore text parsing" keeps the raw title and also puts every field
  // the parse had set back to the composer's defaults, so nothing parsed
  // from the text is saved.
  const ignoreTextParsing = (): void => {
    setIgnoreParse(true);
    setResolvedSpans([]);
    setDate(defaultDate);
    setCategoryId(categoryFilter);
    setProjectId(projectFilter);
    setRepeatKind(defaultRepeatKind);
    setRepeatOverride(null);
    setNlTime(null);
    setNlPriority(null);
    // Forget what was last synced so the next keystroke re-applies every
    // parsed field. The saved title strips the parsed words once parsing
    // resumes, so without this their date, time, project and priority
    // would be dropped along with the text.
    lastSyncedRef.current = null;
  };

  const effectiveRepeat: Repeat = repeatOverride ?? { kind: repeatKind };
  const noteLines = ignoreParse
    ? []
    : parsedNoteLines({ ...parsed, time: nlTime, priority: nlPriority });

  const labelClass = "mb-1 block text-xs font-medium text-muted";

  return (
    <form
      className="safe-bottom shrink-0 border-t border-line bg-paper px-5 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!cleanTitle) return;
        const fullNotes =
          noteLines.length > 0 ? [...noteLines, notes].filter(Boolean).join("\n") : notes;
        addTask({ title: cleanTitle, notes: fullNotes, categoryId, projectId, date, repeat: effectiveRepeat });
        setTitle("");
        setNotes("");
        setDate(defaultDate);
        setCategoryId(categoryFilter);
        setProjectId(projectFilter);
        setRepeatKind(defaultRepeatKind);
        setRepeatOverride(null);
        setNlTime(null);
        setNlPriority(null);
        setIgnoreParse(false);
        setResolvedSpans([]);
        lastSyncedRef.current = null;
      }}
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className={labelClass} htmlFor="new-task">
            Task name
          </label>
          <input
            id="new-task"
            className="field"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add a toduck"
            aria-label="New toduck"
          />
        </div>
        <Button type="submit" variant="primary" disabled={!cleanTitle}>
          Add
        </Button>
      </div>
      {hasParse && !ignoreParse && (
        <div
          className="mt-2 rounded-lg border border-line bg-card px-3 py-2"
          role="region"
          aria-label="Task preview"
          aria-live="polite"
        >
          <p className="text-sm">
            <span className="font-medium">Preview: </span>
            {cleanTitle ? (
              <span>{cleanTitle}</span>
            ) : (
              <span className="text-faint">Add a title — the name so far only sets a date.</span>
            )}
          </p>
          <p className="mt-1 text-xs text-muted">
            {formatWhen(date, today)}
            {` · ${repeatLabel(effectiveRepeat)}`}
            {projectName(projects, projectId) ? ` · ${projectName(projects, projectId)}` : ""}
            {categoryName(categories, categoryId) ? ` · ${categoryName(categories, categoryId)}` : ""}
            {nlTime ? ` · At ${formatTimeLabel(nlTime)}` : ""}
            {nlPriority
              ? ` · Priority: ${{ urgent: "Urgent", high: "High", medium: "Medium", low: "Low" }[nlPriority]}`
              : ""}
          </p>
          {nlTime && (
            <p className="mt-1 text-xs text-muted">
              Time saves as a note line (“At {formatTimeLabel(nlTime)}”).{" "}
              <button type="button" className="underline" onClick={() => setNlTime(null)}>
                Remove time
              </button>
            </p>
          )}
          {nlPriority && (
            <p className="mt-1 text-xs text-muted">
              Priority saves as a note line.{" "}
              <button type="button" className="underline" onClick={() => setNlPriority(null)}>
                Remove priority
              </button>
            </p>
          )}
          {parsed.suggestions.map((suggestion, index) => (
            <p key={`${suggestion.kind}-${index}`} className="mt-1 text-xs">
              {suggestion.decision === "direct" ? (
                <span>
                  Suggested from “{suggestion.source}”: {suggestion.label}.{" "}
                  <button type="button" className="underline" onClick={() => revertSuggestion(suggestion)}>
                    Revert
                  </button>
                </span>
              ) : (
                <span>
                  {suggestion.label}{" "}
                  {suggestion.options?.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className="mr-2 underline"
                      onClick={() => applySuggestionOption(suggestion, option)}
                    >
                      {option.label}
                    </button>
                  ))}
                </span>
              )}
            </p>
          ))}
          {parsed.ambiguities.map((ambiguity) => (
            <p key={ambiguity.text} className="mt-1 text-xs">
              “{ambiguity.text}” could be:{" "}
              {ambiguity.readings.map((reading) => (
                <button
                  key={reading.label}
                  type="button"
                  className="mr-2 underline"
                  onClick={() => applyAmbiguity(ambiguity, reading)}
                >
                  {reading.label}
                </button>
              ))}
            </p>
          ))}
          <p className="mt-1 text-xs text-faint">
            The preview follows the task name; the fields below stay editable.{" "}
            <button type="button" className="underline" onClick={ignoreTextParsing}>
              Ignore text parsing
            </button>
          </p>
        </div>
      )}
      <div className="mt-2">
        <label className={labelClass} htmlFor="new-notes">
          Details
        </label>
        <textarea
          id="new-notes"
          className="field resize-y"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add the details you'll want later."
        />
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="w-44 shrink-0">
          <label className={labelClass} htmlFor="new-date">
            Date
          </label>
          <input
            id="new-date"
            type="date"
            className="field"
            value={date}
            onChange={(event) => {
              if (event.target.value) setDate(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick dates">
          {DATE_PRESETS.map((preset) => {
            const target = presetDate(preset.id, today);
            return (
              <Chip key={preset.id} active={date === target} onClick={() => setDate(target)}>
                {preset.label}
              </Chip>
            );
          })}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 pb-1 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="new-tag">
            Tag
          </label>
          <select
            id="new-tag"
            className="field"
            value={categoryId ?? ""}
            onChange={(event) => setCategoryId(event.target.value || null)}
          >
            <option value="">No tag</option>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="new-repeat">
            Repeat
          </label>
          <select
            id="new-repeat"
            className="field"
            value={repeatOverride ? "__parsed__" : repeatKind}
            onChange={(event) => {
              if (event.target.value === "__parsed__") return;
              setRepeatKind(event.target.value as SimpleRepeatKind);
              setRepeatOverride(null);
            }}
          >
            <option value="none">Once</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            {repeatOverride && (
              <option value="__parsed__">{repeatLabel(repeatOverride)} (from text)</option>
            )}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="new-project">
            Project
          </label>
          <select
            id="new-project"
            className="field"
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value || null)}
          >
            <option value="">No project</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="pb-1 text-xs text-faint">
        Custom repeats and new tags live in a toduck&apos;s details and the Tags dialog. Type a date or
        repeat in the task name — “tomorrow”, “every Monday”, “at 3pm” — and check the preview before
        adding.
      </p>
    </form>
  );
}


