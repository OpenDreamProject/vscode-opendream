// Main module for OpenDream extension.
'use strict';

import { CancellationToken, commands, ExtensionContext, FileType, ProcessExecution, Task, TaskGroup, TaskProvider, workspace } from 'vscode';
import * as vscode from 'vscode';

const TaskNames = {
	SOURCE: 'OpenDream',
	COMPILER: 'build compiler',
	CLIENT: 'build client',
	SERVER: 'build server',
	RUN_COMPILER: (dme: string) => `build - ${dme}`,
	RUN_COMPILER_CURRENT: 'build - ${command:CurrentDME}',
};

// Entry point.
export async function activate(context: ExtensionContext) {
	// ------------------------------------------------------------------------
	// Register commands.

	// Hidden command used in implementing `launch.json`.
	context.subscriptions.push(commands.registerCommand('opendream.getFilenameJson', async () => {
		return (await commands.executeCommand<string>('dreammaker.getFilenameDme'))?.replace(/\.dme$/, ".json");
	}));

	// ------------------------------------------------------------------------
	// Register the task provider for OpenDream build tasks.
	context.subscriptions.push(vscode.tasks.registerTaskProvider('opendream', new OpenDreamTaskProvider()));

	// ------------------------------------------------------------------------
	// Register the debugger mode.

	// I don't really know why this is necessary. The debug configuration this
	// provider returns is the same as the one in "initialConfigurations" in
	// package.json, but apparently VSC uses that only when creating a new
	// launch.json and not when handling an F5 press when a launch.json does
	// not exist.
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('opendream', {
		async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, debugConfiguration: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
			// Called with debugConfiguration = {} if launch.json does not exist.
			return debugConfiguration.type ? debugConfiguration : {
				"type": "opendream",
				"request": "launch",
				"name": "OpenDream",
				"preLaunchTask": `${TaskNames.SOURCE}: ${TaskNames.RUN_COMPILER_CURRENT}`,
				"json_path": "${workspaceFolder}/${command:CurrentJson}",
				"noDebug": debugConfiguration.noDebug || false,
			};
		}
	}));

	// register debugger factory to point at OpenDream's debugger mode
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('opendream', {
		async createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): Promise<vscode.DebugAdapterDescriptor | null> {
			//return new vscode.DebugAdapterServer(result.port);
			return null;
		}
	}));
}

// An alternative approach to using `dotnet run` everywhere would be to use
// tasks running `dotnet build` and `dependsOn` for interdependencies, but
// it's not in the API: https://github.com/microsoft/vscode/issues/132767

class OpenDreamTaskProvider implements TaskProvider {
	async provideTasks(token?: CancellationToken): Promise<Task[]> {
		let openDreamPath = await getOpenDreamSourcePath();
		if (!openDreamPath) {
			return [];
		}

		let list = [];

		// Add build tasks for each .dme in the workspace.
		for (let folder of (workspace.workspaceFolders || [])) {
			for (let [file, type] of await workspace.fs.readDirectory(folder.uri)) {
				if (type == FileType.Directory || !file.endsWith('.dme')) {
					continue;
				}

				let task = new Task(
					{ type: "opendream", },
					folder,
					TaskNames.RUN_COMPILER(file),
					TaskNames.SOURCE,
					new ProcessExecution("dotnet", [
						"run",
						"--project", `${openDreamPath}/DMCompiler`,
						"--",
						file,
					]),
					'$openDreamCompiler'
				);
				task.group = TaskGroup.Build;
				list.push(task);
			}
		};
		return list;
	}

	resolveTask(task: Task, token?: CancellationToken): undefined {
		return;
	}
}

async function getOpenDreamSourcePath(): Promise<string | undefined> {
	// TODO: add UI prompt if the config is unset
	return workspace.getConfiguration('opendream').get('sourcePath');
}
