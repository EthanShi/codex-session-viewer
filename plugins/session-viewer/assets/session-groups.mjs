const UNKNOWN_PROJECT_KEY = "__unknown-project__";

function timestampOf(session) {
  const value = new Date(session?.updatedAt || session?.timestamp || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function projectIdentity(cwd) {
  const displayPath = String(cwd || "").trim();
  if (!displayPath) {
    return {
      key: UNKNOWN_PROJECT_KEY,
      name: "未知项目",
      path: "没有 working directory",
    };
  }

  const slashPath = displayPath.replaceAll("\\", "/");
  const normalizedPath = slashPath.replace(/\/+$/, "") || "/";
  const windowsPath = /^[a-z]:($|\/)|^\/\//i.test(normalizedPath);
  const canonicalPath = windowsPath ? normalizedPath.toLowerCase() : normalizedPath;
  const segments = normalizedPath.split("/").filter(Boolean);
  const name = segments.at(-1) || normalizedPath;

  return { key: `project:${canonicalPath}`, name, path: displayPath };
}

export function groupSessionsByProject(sessions) {
  const groupsByKey = new Map();

  for (const session of sessions) {
    const project = projectIdentity(session.cwd);
    let group = groupsByKey.get(project.key);
    if (!group) {
      group = { ...project, sessions: [], latestTimestamp: 0 };
      groupsByKey.set(project.key, group);
    }
    group.sessions.push(session);
    group.latestTimestamp = Math.max(group.latestTimestamp, timestampOf(session));
  }

  return [...groupsByKey.values()]
    .map((group) => ({
      ...group,
      sessions: group.sessions.sort((left, right) => timestampOf(right) - timestampOf(left)),
    }))
    .sort((left, right) => right.latestTimestamp - left.latestTimestamp);
}
