import type { LocaleResources } from "@multica/core/i18n";
import koDocs from "./ko/docs.json";
import koCommon from "./ko/common.json";
import koQuota from "./ko/quota.json";
import koThinking from "./ko/thinking.json";
import koLark from "./ko/lark.json";
import koForkUi from "./ko/fork-ui.json";
import koDependencies from "./ko/dependencies.json";
import koDag from "./ko/dag.json";
import koAgentConfig from "./ko/agent-config.json";
import koAuth from "./ko/auth.json";
import koSettings from "./ko/settings.json";
import koIssues from "./ko/issues.json";
import koAgents from "./ko/agents.json";
import koEditor from "./ko/editor.json";
import koOnboarding from "./ko/onboarding.json";
import koInvite from "./ko/invite.json";
import koLabels from "./ko/labels.json";
import koMembers from "./ko/members.json";
import koMyIssues from "./ko/my-issues.json";
import koSearch from "./ko/search.json";
import koInbox from "./ko/inbox.json";
import koWorkspace from "./ko/workspace.json";
import koProjects from "./ko/projects.json";
import koAutopilots from "./ko/autopilots.json";
import koSkills from "./ko/skills.json";
import koSkillPackages from "./ko/skill-packages.json";
import koAgentFolders from "./ko/agent-folders.json";
import koChat from "./ko/chat.json";
import koModals from "./ko/modals.json";
import koRuntimes from "./ko/runtimes.json";
import koLayout from "./ko/layout.json";
import koUsage from "./ko/usage.json";
import koUi from "./ko/ui.json";
import koSquads from "./ko/squads.json";
import koBilling from "./ko/billing.json";
import koMessageDelivery from "./ko/message-delivery.json";
import koYouShouldKnow from "./ko/you-should-know.json";
import koEngineering from "./ko/engineering.json";

const resources: LocaleResources = {
  docs: koDocs,
  common: koCommon,
  quota: koQuota,
  thinking: koThinking,
  lark: koLark,
  "fork-ui": koForkUi,
  dependencies: koDependencies,
  dag: koDag,
  "agent-config": koAgentConfig,
  auth: koAuth,
  settings: koSettings,
  issues: koIssues,
  agents: koAgents,
  editor: koEditor,
  onboarding: koOnboarding,
  invite: koInvite,
  labels: koLabels,
  members: koMembers,
  "my-issues": koMyIssues,
  search: koSearch,
  inbox: koInbox,
  workspace: koWorkspace,
  projects: koProjects,
  autopilots: koAutopilots,
  skills: koSkills,
  "skill-packages": koSkillPackages,
  "agent-folders": koAgentFolders,
  chat: koChat,
  modals: koModals,
  runtimes: koRuntimes,
  layout: koLayout,
  usage: koUsage,
  ui: koUi,
  squads: koSquads,
  billing: koBilling,
  "message-delivery": koMessageDelivery,
  "you-should-know": koYouShouldKnow,
  engineering: koEngineering,
};

export default resources;
