import { useCallback } from 'react';
import type { FlowWizardStep, UseFlowReturn } from '../../components/Flow.js';
import type {
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
} from '../../session/backend.js';
import type { ConfirmStepResult, OnboardingStep } from '../../types/bundle.js';
import type { SessionLinearIssueSummary, WorkspaceSource } from '../../types/lifecycle.js';
import { SpacesError } from '../../types/errors.js';
import { logger } from '../../utils/logger.js';
import {
  extractRepoName,
  generateWorkspaceName,
  isValidBranchName,
  sanitizeForFileSystem,
} from '../../utils/sanitize.js';

export interface WorkspaceCreatedDetails {
  projectName: string;
  workspaceName: string;
  workspaceId: string;
  branchName?: string;
  workspaceSource?: WorkspaceSource;
}

export interface ProjectCreatedDetails {
  projectName: string;
  repository: string;
}

export interface UseLifecycleControllerOptions {
  flow: Pick<
    UseFlowReturn,
    'showLoading' | 'showSelect' | 'showInput' | 'showConfirmTyped' | 'showMessage' | 'showWizard' | 'close'
  >;
  listGithubRepos: (org?: string) => Promise<string[]>;
  listRemoteBranches: (projectName: string) => Promise<string[]>;
  listLinearIssues: (projectName: string) => Promise<SessionLinearIssueSummary[]>;
  createProject: (params: CreateProjectParams) => Promise<void>;
  prepareProjectCreation?: (params: CreateProjectParams) => Promise<PreparedProjectResult>;
  finalizeProjectCreation?: (params: FinalizeProjectParams) => Promise<void>;
  cancelProjectCreation?: (projectName: string) => Promise<void>;
  createWorkspace: (params: CreateWorkspaceParams) => Promise<void>;
  deleteProject: (projectName: string, params?: DeleteProjectParams) => Promise<void>;
  getProjectNames: () => string[];
  refreshProjects: () => void | Promise<void>;
  refreshWorkspaces: () => void | Promise<void>;
  refreshSessions?: () => void | Promise<void>;
  onProjectCreated?: (details: ProjectCreatedDetails) => void | Promise<void>;
  onWorkspaceCreated?: (details: WorkspaceCreatedDetails) => void | Promise<void>;
  showCreateWorkspaceSuccessMessage?: boolean;
}

export interface UseLifecycleControllerResult {
  openCreateProjectFlow: () => void;
  openCreateWorkspaceFlow: (projectName?: string | null) => void;
  openDeleteProjectFlow: (projectName: string) => void;
  openCreateMenu: (projectName?: string | null) => void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return fallback;
}

function defaultProjectNameForRepo(repo: string): string {
  const extracted = extractRepoName(repo);
  return sanitizeForFileSystem(extracted) || extracted;
}

function buildLinearIssueLabel(issue: SessionLinearIssueSummary): string {
  const trimmedTitle = issue.title.trim();
  if (trimmedTitle.length <= 60) {
    return `${issue.identifier} - ${trimmedTitle}`;
  }
  return `${issue.identifier} - ${trimmedTitle.slice(0, 57)}...`;
}

function buildOnboardingValidation(step: OnboardingStep): ((value: string) => string | null) | undefined {
  if (step.type !== 'input' && step.type !== 'secret') {
    return undefined;
  }

  return (value: string) => {
    const trimmed = value.trim();
    if (step.required !== false && trimmed.length === 0) {
      return `${step.title} is required`;
    }

    if (trimmed.length === 0 || !step.validationPattern) {
      return null;
    }

    try {
      const regex = new RegExp(step.validationPattern);
      return regex.test(trimmed) ? null : step.validationMessage ?? `Invalid value for ${step.title}`;
    } catch {
      return `Invalid validation pattern for ${step.title}`;
    }
  };
}

function toWizardSteps(
  steps: OnboardingStep[],
  confirmStatuses?: Record<string, 'found' | 'missing'>
): FlowWizardStep[] {
  return steps.map((step) => {
    if (step.type === 'info') {
      return {
        id: step.id,
        title: step.title,
        type: 'info' as const,
        description: step.description,
      };
    }

    if (step.type === 'confirm') {
      return {
        id: step.id,
        title: step.title,
        type: 'confirm' as const,
        description: step.description,
        checkCommand: step.checkCommand,
        checkStatus: step.checkCommand ? confirmStatuses?.[step.id] : undefined,
        installUrl: step.installUrl,
      };
    }

    if (step.type === 'select') {
      return {
        id: step.id,
        title: step.title,
        type: 'select',
        description: step.description,
        defaultValue: step.defaultValue,
        options: step.options.map((option) => ({ label: option.label, value: option.value })),
      };
    }

    return {
      id: step.id,
      title: step.title,
      type: step.type,
      description: step.description,
      defaultValue: step.type === 'input' ? step.defaultValue : undefined,
      validation: buildOnboardingValidation(step),
    };
  });
}

const SOURCE_OPTIONS: Array<{
  label: string;
  description: string;
  value: WorkspaceSource;
}> = [
  {
    label: 'GitHub Branch',
    description: 'Create from an existing remote branch',
    value: 'branch',
  },
  {
    label: 'Linear Issue',
    description: 'Create from a Linear ticket',
    value: 'linear',
  },
  {
    label: 'Manual Name',
    description: 'Enter a custom workspace name',
    value: 'manual',
  },
];

export function useLifecycleController(
  options: UseLifecycleControllerOptions
): UseLifecycleControllerResult {
  const {
    flow,
    listGithubRepos,
    listRemoteBranches,
    listLinearIssues,
    createProject,
    prepareProjectCreation,
    finalizeProjectCreation,
    cancelProjectCreation,
    createWorkspace,
    deleteProject,
    getProjectNames,
    refreshProjects,
    refreshWorkspaces,
    refreshSessions,
    onProjectCreated,
    onWorkspaceCreated,
    showCreateWorkspaceSuccessMessage = true,
  } = options;

  const refreshAll = useCallback(async () => {
    await refreshProjects();
    await refreshWorkspaces();
    if (refreshSessions) {
      await refreshSessions();
    }
  }, [refreshProjects, refreshSessions, refreshWorkspaces]);

  const createWorkspaceWithFeedback = useCallback(async (
    params: CreateWorkspaceParams,
    workspaceSource?: WorkspaceSource
  ) => {
    flow.showLoading({
      title: 'Creating Workspace',
      message: `Creating ${params.workspaceName}...`,
    });

    try {
      await createWorkspace(params);
      await refreshAll();
      await onWorkspaceCreated?.({
        projectName: params.projectName,
        workspaceName: params.workspaceName,
        workspaceId: `${params.projectName}:${params.workspaceName}`,
        branchName: params.branchName,
        workspaceSource,
      });

      if (showCreateWorkspaceSuccessMessage) {
        flow.showMessage({
          title: 'Workspace Created',
          message: `Created workspace "${params.workspaceName}" in ${params.projectName}.`,
          variant: 'success',
        });
      } else {
        flow.close();
      }
    } catch (error) {
      flow.showMessage({
        title: 'Create Workspace Failed',
        message: toErrorMessage(error, 'Failed to create workspace'),
        variant: 'error',
      });
    }
  }, [
    createWorkspace,
    flow,
    onWorkspaceCreated,
    refreshAll,
    showCreateWorkspaceSuccessMessage,
  ]);

  const openCreateProjectFlow = useCallback(() => {
    const completeProjectCreation = async (projectName: string, repo: string) => {
      await refreshAll();
      await onProjectCreated?.({ projectName, repository: repo });
      flow.showMessage({
        title: 'Project Created',
        message: `Created project "${projectName}" from ${repo}.`,
        variant: 'success',
      });
    };

    const startOnboardingFlow = (prepared: PreparedProjectResult) => {
      const onboardingSteps = prepared.bundle?.onboarding ?? [];
      if (onboardingSteps.length === 0) {
        return false;
      }

      if (!finalizeProjectCreation || !cancelProjectCreation) {
        logger.error(`[lifecycle] Missing project onboarding backend support for ${prepared.projectName}`);
        throw new SpacesError(
          'Project onboarding requires prepare, finalize, and cancel support',
          'SYSTEM_ERROR',
          2
        );
      }

      flow.showWizard({
        title: `Set Up ${prepared.projectName}`,
        steps: toWizardSteps(onboardingSteps, prepared.confirmStatuses),
        onCancel: () => {
          if (cancelProjectCreation) {
            void cancelProjectCreation(prepared.projectName).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`[lifecycle] Failed to cancel project creation for ${prepared.projectName}: ${message}`);
            });
          }
        },
        onComplete: async (values) => {
          flow.showLoading({
            title: 'Creating Project',
            message: `Finalizing ${prepared.projectName}...`,
          });

          try {
            const inputValues: Record<string, string> = {};
            const secretValues: Record<string, string> = {};
            const confirmResults: Record<string, ConfirmStepResult> = {};

            for (const step of onboardingSteps) {
              if ((step.type === 'input' || step.type === 'select') && step.configKey) {
                const defaultValue = step.defaultValue ?? '';
                inputValues[step.configKey] = (values[step.id] ?? defaultValue).trim();
                continue;
              }

              if (step.type === 'secret') {
                secretValues[step.configKey] = (values[step.id] ?? '').trim();
                continue;
              }

              if (step.type === 'confirm') {
                confirmResults[step.id] = {
                  status: step.checkCommand
                    ? prepared.confirmStatuses?.[step.id] === 'found' ? 'passed' : 'skipped'
                    : 'passed',
                  checkCommand: step.checkCommand,
                };
              }
            }

            await finalizeProjectCreation({
              projectName: prepared.projectName,
              repository: prepared.repository,
              baseBranch: prepared.baseBranch,
              bundle: prepared.bundle,
              inputValues,
              secretValues,
              confirmResults,
            });
            await completeProjectCreation(prepared.projectName, prepared.repository);
          } catch (error) {
            flow.showMessage({
              title: 'Create Project Failed',
              message: toErrorMessage(error, 'Failed to create project'),
              variant: 'error',
            });
          }
        },
      });

      return true;
    };

    const openProjectNamePrompt = (repo: string) => {
      const defaultName = defaultProjectNameForRepo(repo);

      flow.showInput({
        title: 'Project Name',
        label: `Project name for ${repo}:`,
        defaultValue: defaultName,
        validation: (value) => {
          if (!value.trim()) {
            return 'Project name is required';
          }
          const sanitized = sanitizeForFileSystem(value.trim());
          if (!sanitized) {
            return 'Project name must contain at least one letter or number';
          }
          return null;
        },
        onSubmit: async (value) => {
          const projectName = value.trim();
          flow.showLoading({
            title: 'Creating Project',
            message: `Cloning ${repo}...`,
          });

          try {
            if (prepareProjectCreation && finalizeProjectCreation && cancelProjectCreation) {
              const prepared = await prepareProjectCreation({ repository: repo, projectName });
              if (startOnboardingFlow(prepared)) {
                return;
              }

              await finalizeProjectCreation({
                projectName: prepared.projectName,
                repository: prepared.repository,
                baseBranch: prepared.baseBranch,
                bundle: prepared.bundle,
              });
              await completeProjectCreation(prepared.projectName, prepared.repository);
              return;
            }

            await createProject({ repository: repo, projectName });
            await completeProjectCreation(projectName, repo);
          } catch (error) {
            flow.showMessage({
              title: 'Create Project Failed',
              message: toErrorMessage(error, 'Failed to create project'),
              variant: 'error',
            });
          }
        },
      });
    };

    const openManualRepoPrompt = () => {
      flow.showInput({
        title: 'Repository Remote',
        label: 'Repository remote URL (or owner/repo):',
        placeholder: 'https://github.com/org/repo.git',
        validation: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return 'Repository is required';
          }

          const looksLikeOwnerRepo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed);
          const looksLikeRemoteUrl =
            trimmed.includes('://') ||
            trimmed.startsWith('git@') ||
            trimmed.startsWith('ssh://');

          if (!looksLikeOwnerRepo && !looksLikeRemoteUrl) {
            return 'Enter a git remote URL or owner/repo shorthand';
          }

          return null;
        },
        onSubmit: (repoValue) => {
          openProjectNamePrompt(repoValue.trim());
        },
      });
    };

    flow.showSelect({
      title: 'Create Project From',
      options: [
        {
          label: 'Git Remote URL',
          description: 'Enter a remote URL directly',
          value: 'manual' as const,
        },
        {
          label: 'GitHub Repository',
          description: 'Select from GitHub (optional)',
          value: 'github' as const,
        },
      ],
      onSelect: (source) => {
        if (source === 'manual') {
          openManualRepoPrompt();
          return;
        }

        flow.showLoading({
          title: 'Loading Repositories',
          message: 'Fetching GitHub repositories...',
        });

        void (async () => {
          try {
            const repos = await listGithubRepos();
            flow.close();

            if (repos.length === 0) {
              flow.showMessage({
                title: 'No Repositories',
                message: 'No GitHub repositories found for this machine identity.',
                variant: 'warning',
              });
              return;
            }

            flow.showSelect({
              title: 'Select Repository',
              options: repos.map((repo) => ({ label: repo, value: repo })),
              onSelect: (repo) => {
                openProjectNamePrompt(repo);
              },
            });
          } catch (error) {
            flow.close();
            flow.showMessage({
              title: 'GitHub Repositories Unavailable',
              message: toErrorMessage(error, 'Failed to fetch GitHub repositories'),
              variant: 'warning',
            });
            openManualRepoPrompt();
          }
        })();
      },
    });
  }, [
    cancelProjectCreation,
    createProject,
    finalizeProjectCreation,
    flow,
    listGithubRepos,
    onProjectCreated,
    prepareProjectCreation,
    refreshAll,
  ]);

  const openManualWorkspaceFlow = useCallback((projectName: string) => {
    flow.showInput({
      title: 'New Workspace (1/2)',
      label: 'Workspace name:',
      placeholder: 'feature/my-change',
      validation: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Workspace name is required';
        }
        const sanitized = sanitizeForFileSystem(trimmed);
        if (!sanitized) {
          return 'Workspace name must contain at least one letter or number';
        }
        if (!isValidBranchName(trimmed)) {
          return 'Invalid branch name (no spaces, .., or special chars like : ? * [ \\ ~)';
        }
        return null;
      },
      onSubmit: async (value) => {
        const rawWorkspaceInput = value.trim();
        const workspaceName = sanitizeForFileSystem(rawWorkspaceInput);
        if (!workspaceName) {
          flow.showMessage({
            title: 'Create Workspace Failed',
            message: 'Workspace name must contain at least one letter or number',
            variant: 'error',
          });
          return;
        }

        flow.showInput({
          title: 'New Workspace (2/2)',
          label: 'Branch name (slashes allowed):',
          defaultValue: rawWorkspaceInput,
          validation: (branchValue) => {
            const finalBranch = branchValue.trim() || rawWorkspaceInput;
            if (!isValidBranchName(finalBranch)) {
              return 'Invalid branch name (no spaces, .., or special chars like : ? * [ \\ ~)';
            }
            return null;
          },
          onSubmit: async (branchValue) => {
            const finalBranch = branchValue.trim() || rawWorkspaceInput;
            await createWorkspaceWithFeedback(
              {
                projectName,
                workspaceName,
                branchName: finalBranch,
                workspaceSource: 'manual',
              },
              'manual'
            );
          },
        });
      },
    });
  }, [createWorkspaceWithFeedback, flow]);

  const openBranchWorkspaceFlow = useCallback((projectName: string) => {
    flow.showLoading({
      title: 'Loading Branches',
      message: `Fetching remote branches for ${projectName}...`,
    });

    void (async () => {
      try {
        const branches = await listRemoteBranches(projectName);
        flow.close();

        if (branches.length === 0) {
          flow.showMessage({
            title: 'No Branches',
            message: 'No remote branches are available for this project.',
            variant: 'warning',
          });
          return;
        }

        flow.showSelect({
          title: 'Select Branch',
          searchable: true,
          options: branches.map((branch) => ({ label: branch, value: branch })),
          onSelect: async (branch) => {
            const workspaceName = sanitizeForFileSystem(branch);
            if (!workspaceName) {
              flow.showMessage({
                title: 'Create Workspace Failed',
                message: 'Selected branch cannot be converted to a workspace name.',
                variant: 'error',
              });
              return;
            }

            await createWorkspaceWithFeedback(
              {
                projectName,
                workspaceName,
                branchName: branch,
                workspaceSource: 'branch',
              },
              'branch'
            );
          },
        });
      } catch (error) {
        flow.close();
        flow.showMessage({
          title: 'Branch Fetch Failed',
          message: toErrorMessage(error, 'Failed to fetch remote branches'),
          variant: 'error',
        });
      }
    })();
  }, [createWorkspaceWithFeedback, flow, listRemoteBranches]);

  const openLinearWorkspaceFlow = useCallback((projectName: string) => {
    flow.showLoading({
      title: 'Loading Linear Issues',
      message: `Fetching Linear issues for ${projectName}...`,
    });

    void (async () => {
      try {
        const issues = await listLinearIssues(projectName);
        flow.close();

        if (issues.length === 0) {
          flow.showMessage({
            title: 'No Issues',
            message: 'No unstarted Linear issues found for this project.',
            variant: 'warning',
          });
          return;
        }

        flow.showSelect({
          title: 'Select Linear Issue',
          searchable: true,
          options: issues.map((issue) => ({
            label: buildLinearIssueLabel(issue),
            value: issue,
          })),
          onSelect: async (issue) => {
            const workspaceName = generateWorkspaceName(issue.identifier, issue.title);
            await createWorkspaceWithFeedback(
              {
                projectName,
                workspaceName,
                branchName: workspaceName,
                workspaceSource: 'linear',
                linearIssue: issue,
              },
              'linear'
            );
          },
        });
      } catch (error) {
        flow.close();
        flow.showMessage({
          title: 'Linear Fetch Failed',
          message: toErrorMessage(error, 'Failed to fetch Linear issues'),
          variant: 'error',
        });
      }
    })();
  }, [createWorkspaceWithFeedback, flow, listLinearIssues]);

  const openWorkspaceSourceFlow = useCallback((projectName: string) => {
    flow.showSelect({
      title: 'Create Workspace From',
      options: SOURCE_OPTIONS,
      onSelect: (source) => {
        if (source === 'branch') {
          openBranchWorkspaceFlow(projectName);
          return;
        }
        if (source === 'linear') {
          openLinearWorkspaceFlow(projectName);
          return;
        }
        openManualWorkspaceFlow(projectName);
      },
    });
  }, [flow, openBranchWorkspaceFlow, openLinearWorkspaceFlow, openManualWorkspaceFlow]);

  const openCreateWorkspaceFlow = useCallback((projectName?: string | null) => {
    const projects = getProjectNames();
    if (projects.length === 0) {
      flow.showMessage({
        title: 'No Projects',
        message: 'Create a project first before creating a workspace.',
        variant: 'warning',
      });
      return;
    }

    const selectedProject = projectName?.trim() ? projectName.trim() : null;
    if (selectedProject && projects.includes(selectedProject)) {
      openWorkspaceSourceFlow(selectedProject);
      return;
    }

    if (projects.length === 1) {
      openWorkspaceSourceFlow(projects[0]);
      return;
    }

    flow.showSelect({
      title: 'Select Project',
      options: projects.map((name) => ({ label: name, value: name })),
      onSelect: (name) => {
        openWorkspaceSourceFlow(name);
      },
    });
  }, [flow, getProjectNames, openWorkspaceSourceFlow]);

  const openDeleteProjectFlow = useCallback((projectName: string) => {
    flow.showConfirmTyped({
      title: 'Delete Project',
      message: `Delete project "${projectName}" and all of its workspaces?`,
      confirmText: projectName,
      warning: 'This action permanently removes the entire project directory.',
      onConfirm: async () => {
        flow.showLoading({
          title: 'Deleting Project',
          message: `Deleting ${projectName}...`,
        });

        try {
          await deleteProject(projectName);
          await refreshAll();
          flow.showMessage({
            title: 'Project Deleted',
            message: `Deleted project "${projectName}".`,
            variant: 'success',
          });
        } catch (error) {
          flow.showMessage({
            title: 'Delete Project Failed',
            message: toErrorMessage(error, 'Failed to delete project'),
            variant: 'error',
          });
        }
      },
    });
  }, [deleteProject, flow, refreshAll]);

  const openCreateMenu = useCallback((projectName?: string | null) => {
    const projects = getProjectNames();
    if (projects.length === 0) {
      openCreateProjectFlow();
      return;
    }

    flow.showSelect({
      title: 'Create',
      options: [
        { label: 'Workspace', description: 'Create a new workspace', value: 'workspace' as const },
        { label: 'Project', description: 'Clone a git repository', value: 'project' as const },
      ],
      onSelect: (value) => {
        if (value === 'workspace') {
          openCreateWorkspaceFlow(projectName);
          return;
        }
        openCreateProjectFlow();
      },
    });
  }, [flow, getProjectNames, openCreateProjectFlow, openCreateWorkspaceFlow]);

  return {
    openCreateProjectFlow,
    openCreateWorkspaceFlow,
    openDeleteProjectFlow,
    openCreateMenu,
  };
}
