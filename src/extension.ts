// Main module for OpenDream extension.
'use strict';

import * as net from 'net';
import { CancellationToken, commands, DebugProtocolMessage, ExtensionContext, FileType, ProcessExecution, Task, TaskGroup, TaskProvider, workspace } from 'vscode';
import * as vscode from 'vscode';

const TaskNames = {
	SOURCE: 'OpenDream',
	COMPILER: 'build compiler',
	CLIENT: 'build client',
	SERVER: 'build server',
	RUN_COMPILER: (dme: string) => `build - ${dme}`,
	RUN_COMPILER_CURRENT: 'build - ${command:CurrentDME}',
};

// ----------------------------------------------------------------------------
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
			let openDreamPath = await getOpenDreamSourcePath();
			if (!openDreamPath) {
				return null;
			}

			// Start a server and listen on an arbitrary port.
			let server: net.Server;
			let socketPromise = new Promise<net.Socket>(resolve => server = net.createServer(resolve));
			server = server!;
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

			// Boot the OD server pointing at that port.
			// Use executeTask instead of createTerminal so it will be readable if it crashes.
			let task = new Task(
				{ type: 'opendream_debug_server' },
				session.workspaceFolder || vscode.TaskScope.Workspace,
				'OpenDream server',
				TaskNames.SOURCE,
				new ProcessExecution("dotnet", [
					"run",
					"--project", `${openDreamPath}/OpenDreamServer`,
					"--",
					"--cvar", `server.port=0`,
					"--cvar", `opendream.debug_adapter_launched=${server.address().port}`,
					"--cvar", `opendream.json_path=${session.configuration.json_path}`,
				]),
			);
			task.presentationOptions.panel = vscode.TaskPanelKind.Dedicated;
			vscode.tasks.executeTask(task);

			// Wait for the OD server to connect back to us, then stop listening.
			let socket = await socketPromise;
			server!.close(); // No need to wait for this before proceeding, so just let it ride.

			return new vscode.DebugAdapterInlineImplementation(new OpenDreamDebugAdapter(socket));
		}
	}));
}

// ----------------------------------------------------------------------------
// Task provider

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

// ----------------------------------------------------------------------------
// Debug adapter

class OpenDreamDebugAdapter implements vscode.DebugAdapter {
	private socket: net.Socket;
	private buffer = Buffer.alloc(0);

	private didSendMessageEmitter = new vscode.EventEmitter<DebugProtocolMessage>();
	private sendMessageToEditor = this.didSendMessageEmitter.fire.bind(this.didSendMessageEmitter);
	onDidSendMessage = this.didSendMessageEmitter.event;

	constructor(socket: net.Socket) {
		this.socket = socket;
		socket.on('data', received => {
			// Append received data to buffer.
			let old = this.buffer;
			this.buffer = Buffer.alloc(old.length + received.length);
			old.copy(this.buffer);
			received.copy(this.buffer, old.length);

			// Attempt to chop off a complete message.
			let headerEnd = this.buffer.indexOf('\r\n\r\n');
			while (headerEnd >= 0) {
				let headers = this.buffer.toString('utf-8', 0, headerEnd);
				let contentLength = Number(/Content-length: (\d+)/i.exec(headers)![1]);
				let dataEnd = headerEnd + 4 + contentLength;
				if (dataEnd > this.buffer.length) {
					break;
				}

				try {
					this.handleMessageFromGame(JSON.parse(this.buffer.toString('utf-8', headerEnd + 4, dataEnd)));
				} catch (e) {
					console.error(e);
				}

				this.buffer = Buffer.from(this.buffer.buffer.slice(this.buffer.byteOffset + dataEnd));
				headerEnd = this.buffer.indexOf('\r\n\r\n');
			}
		});
	}

	handleMessage(message: DebugProtocolMessage): void {
		this.sendMessageToGame(message);
	}

	private sendMessageToGame(message: DebugProtocolMessage): void {
		console.log('-->', message);
		let json = JSON.stringify(message);
		this.socket.write(`Content-Length: ${json.length}\r\n\r\n${json}`);
	}

	private async handleMessageFromGame(message: any): Promise<void> {
		console.log('<--', message);
		if (message.type == 'response' && message.command == 'launch' && message.body && '$opendream/port' in message.body) {
			// Launch the OD client.
			let openDreamPath = await getOpenDreamSourcePath();
			let gamePort = message.body['$opendream/port'];
			console.log('Port for client to connect to:', gamePort);
			let task = new Task(
				{ type: 'opendream_debug_client' },  // Must differ from the one used above or else VSC will confuse them.
				vscode.TaskScope.Workspace,
				'OpenDream client',
				TaskNames.SOURCE,
				new ProcessExecution("dotnet", [
					"run",
					"--project", `${openDreamPath}/OpenDreamClient`,
					"--",
					"--connect",
					"--connect-address", `127.0.0.1:${gamePort}`,
				]),
			);
			task.presentationOptions.panel = vscode.TaskPanelKind.Dedicated;
			await vscode.tasks.executeTask(task);
		}
		this.sendMessageToEditor(message);
	}

	dispose() {
		this.socket.destroy();
		this.didSendMessageEmitter.dispose();
	}
}
