import { getCurrentProject, getProjectDir } from '../core/config'
import { SpacesError } from '../types/errors'
import { logger } from '../utils/logger'

export async function getProjectDirectory(options: {
	json?: boolean
	verbose?: boolean
}): Promise<void> {
	const currentProject = getCurrentProject()
	if (!currentProject) {
		throw new SpacesError('No project found', 'USER_ERROR', 1)
	}

	const projectDirectory = getProjectDir(currentProject)
	console.log(projectDirectory)
}
