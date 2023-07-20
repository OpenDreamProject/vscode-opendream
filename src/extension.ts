// Main module for OpenDream extension.
'use strict';

import * as net from 'net';
import * as fs from 'fs';
import { CancellationToken, commands, DebugProtocolMessage, ExtensionContext, FileType, ProcessExecution, Task, TaskGroup, TaskProvider, workspace } from 'vscode';
import * as vscode from 'vscode';

const TaskNames = {
	SOURCE: 'OpenDream',
	BUILD_COMPILER: 'build compiler',
	BUILD_CLIENT: 'build client',
	BUILD_SERVER: 'build server',
	RUN_COMPILER: (dme: string) => `compile ${dme}`,
	RUN_COMPILER_CURRENT: 'compile ${command:CurrentDME}',
	RUN_CLIENT: 'client',
	RUN_SERVER: 'server',
};

let clientTask: vscode.TaskExecution | undefined;

/*
Correctness notes:
	- Tasks passed to `executeTask` must have unique `type` values in their definitions, or VSC will confuse them.
	- `executeTask` is preferred over `createTerminal` for persistence niceties, like the output remaining readable on crash.
*/

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
			if (debugConfiguration.type) {
				return debugConfiguration;
			}
			return {
				"type": "opendream",
				"request": "launch",
				"name": `OD: ${await commands.executeCommand<string>('dreammaker.getFilenameDme')}`,
				"preLaunchTask": `${TaskNames.SOURCE}: ${TaskNames.RUN_COMPILER_CURRENT}`,
				"json_path": "${workspaceFolder}/${command:CurrentJson}",
				"noDebug": debugConfiguration.noDebug || false,
			};
		}
	}));

	// register debugger factory to point at OpenDream's debugger mode
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('opendream', {
		async createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): Promise<vscode.DebugAdapterDescriptor | null> {
			let openDream = await getOpenDreamInstallation();
			if (!openDream) {
				return null;
			}
			console.log('Starting OpenDream debug session ----------');

			// Start a server and listen on an arbitrary port.
			let server: net.Server;
			let socketPromise = new Promise<net.Socket>(resolve => server = net.createServer(resolve));
			server = server!;
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

			let buildClientPromise = openDream.buildClient(session.workspaceFolder);

			// Boot the OD server pointing at that port.
			await openDream.startServer({
				workspaceFolder: session.workspaceFolder,
				debugPort: server.address().port,
				json_path: session.configuration.json_path,
			});

			// Wait for the OD server to connect back to us, then stop listening.
			let socket = await socketPromise;
			server!.close(); // No need to wait for this before proceeding, so just let it ride.

			return new vscode.DebugAdapterInlineImplementation(new OpenDreamDebugAdapter(socket, buildClientPromise));
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
		let openDream = await getOpenDreamInstallation();
		if (!openDream) {
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
					openDream.getCompilerExecution(file),
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

// ----------------------------------------------------------------------------
// Debug adapter

class OpenDreamDebugAdapter implements vscode.DebugAdapter {
	private buildClientPromise?: Promise<ODClient>;

	private socket: net.Socket;
	private buffer = Buffer.alloc(0);

	private didSendMessageEmitter = new vscode.EventEmitter<DebugProtocolMessage>();
	private sendMessageToEditor = this.didSendMessageEmitter.fire.bind(this.didSendMessageEmitter);
	onDidSendMessage = this.didSendMessageEmitter.event;

	constructor(socket: net.Socket, buildClientPromise?: Promise<ODClient>) {
		this.socket = socket;
		this.buildClientPromise = buildClientPromise;

		// Handle any error condition by terminating debugging, to avoid the
		// session hanging around when it isn't attached to anything. Sending
		// "terminated" multiple times seems to be fine.
		socket.on('error', error => {
			console.error('OpenDreamDebugAdapter:', error);
			this.sendMessageToEditor({ type: "event", event: "terminated" });
		});
		socket.on('close', () => {
			console.log('OpenDreamDebugAdapter closed');
			this.sendMessageToEditor({ type: "event", event: "terminated" });
		});
		socket.on('end', () => {
			console.log('OpenDreamDebugAdapter ended');
			this.sendMessageToEditor({ type: "event", event: "terminated" });
		});

		// Handle received data.
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
					let message = JSON.parse(this.buffer.toString('utf-8', headerEnd + 4, dataEnd));
					console.log('<--', contentLength, message);
					this.handleMessageFromGame(message);
				} catch (e) {
					console.error(e);
				}

				this.buffer = Buffer.from(this.buffer.buffer.slice(this.buffer.byteOffset + dataEnd));
				headerEnd = this.buffer.indexOf('\r\n\r\n');
			}
		});
	}

	handleMessage(message: any): void {
		if (message.type == 'request' && message.command == 'disconnect') {
			// Kill the client when the Stop button is clicked.
			// This has the unfortunate side-effect of removing its terminal entirely.
			clientTask?.terminate();
			clientTask = undefined;
		}
		this.sendMessageToGame(message);
	}

	private sendMessageToGame(message: DebugProtocolMessage): void {
		let json = JSON.stringify(message);
		console.log('-->', json.length, message);
		this.socket.write(`Content-Length: ${json.length}\r\n\r\n${json}`);
	}

	private async handleMessageFromGame(message: any): Promise<void> {
		if (message.type == 'event' && message.event == '$opendream/ready') {
			// Launch the OD client.
			let gamePort = message.body.gamePort;
			this.buildClientPromise?.then(async client => {
				clientTask = await client.start(gamePort);
			});
		}
		this.sendMessageToEditor(message);
	}

	dispose() {
		this.socket.destroy();
		this.didSendMessageEmitter.dispose();
	}
}

// ----------------------------------------------------------------------------
// Abstraction over possible OpenDream installation methods.

interface OpenDreamInstallation {
	getCompilerExecution(dme: string): ProcessExecution | vscode.ShellExecution | vscode.CustomExecution;
	buildClient(workspaceFolder?: vscode.WorkspaceFolder): Promise<ODClient>;
	startServer(params: { workspaceFolder?: vscode.WorkspaceFolder, debugPort: number, json_path: string }): Promise<void>;
}

interface ODClient {
	start(gamePort: number): Promise<vscode.TaskExecution>;
}

async function getOpenDreamInstallation(): Promise<OpenDreamInstallation | undefined> {
	function exists(path: string): Promise<boolean> {
		return new Promise(resolve => fs.exists(path, resolve));
	}
	function isOpenDreamSource(path: string): Promise<boolean> {
		return exists(`${path}/OpenDream.sln`);
	}
	async function selectOpenDreamPath(message: string, oldValue?: string): Promise<string | undefined> {
		let choice = await vscode.window.showInformationMessage(message, "Configure", "Not now");
		if (choice !== "Configure") {
			return undefined;
		}

		let selection = await vscode.window.showOpenDialog({
			defaultUri: oldValue ? vscode.Uri.file(oldValue) : undefined,
			canSelectFiles: false,
			canSelectFolders: true,
		});
		if (!selection) {  // cancelled
			return undefined;
		}
		if (selection[0].scheme !== 'file') {
			return oldValue;
		}
		var value = selection[0].fsPath;
		workspace.getConfiguration('opendream').update('sourcePath', value, vscode.ConfigurationTarget.Global);
		return value;
	}

	// Check if one of the workspace folders is an OpenDream source checkout.
	for (let folder of workspace.workspaceFolders || []) {
		if (folder.uri.scheme === 'file' && await isOpenDreamSource(folder.uri.fsPath)) {
			return new ODWorkspaceFolderInstallation(folder);
		}
	}

	// Check if the configured path is a valid OpenDream source checkout.
	let configuredPath: string | undefined = workspace.getConfiguration('opendream').get('sourcePath');
	if (!configuredPath) {
		configuredPath = await selectOpenDreamPath("This feature requires an OpenDream path to be configured. Select now?", configuredPath);
		if (!configuredPath) {
			return;
		}
	}

	do {
		if (await isOpenDreamSource(configuredPath)) {
			return new ODSourceInstallation(configuredPath);
		}

		// When OD starts shipping a binary distribution, attempt ODBinaryDistribution here.

		// Doesn't appear to be valid; prompt for another.
		configuredPath = await selectOpenDreamPath("The folder you selected does not contain `OpenDream.sln`. Select again?", configuredPath);
	} while (configuredPath);
}

// Hypothetical OD binary distribution; not used because OD doesn't have one.
// @ts-ignore
class ODBinaryDistribution implements OpenDreamInstallation {
	protected path: string;

	constructor(path: string) {
		this.path = path;
	}

	getCompilerExecution(dme: string): ProcessExecution {
		return new ProcessExecution(`${this.path}/DMCompiler`, [
			dme,
		]);
	}

	async buildClient(workspaceFolder?: vscode.WorkspaceFolder): Promise<ODClient> {
		return {
			start: async (gamePort) => {
				return await startDedicatedTask(new Task(
					{ type: 'opendream_debug_client' },
					workspaceFolder || vscode.TaskScope.Workspace,
					TaskNames.RUN_CLIENT,
					TaskNames.SOURCE,
					new ProcessExecution(`${this.path}/OpenDreamClient`, [
						"--connect",
						"--connect-address", `127.0.0.1:${gamePort}`,
					]),
				));
			}
		}
	}

	async startServer(params: { workspaceFolder?: vscode.WorkspaceFolder, debugPort: number, json_path: string }): Promise<void> {
		await startDedicatedTask(new Task(
			{ type: 'opendream_debug_server' },
			params.workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.RUN_SERVER,
			TaskNames.SOURCE,
			new ProcessExecution(`${this.path}/OpenDreamServer`, [
				"--cvar", `server.port=0`,
				"--cvar", `opendream.debug_adapter_launched=${params.debugPort}`,
				"--cvar", `opendream.json_path=${params.json_path}`,
			]),
		));
	}
}

// OpenDream source code, to be built & run.
class ODSourceInstallation implements OpenDreamInstallation {
	protected path: string;

	constructor(path: string) {
		this.path = path;
	}

	getCompilerExecution(dme: string): ProcessExecution {
		return new ProcessExecution("dotnet", [
			"run",
			"--project", `${this.path}/DMCompiler`,
			"--",
			dme,
		]);
	}

	async buildClient(workspaceFolder?: vscode.WorkspaceFolder): Promise<ODClient> {
		await waitForTaskToEnd(await startDedicatedTask(new Task(
			{ type: 'opendream_debug_client' },
			workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.BUILD_CLIENT,
			TaskNames.SOURCE,
			new ProcessExecution("dotnet", [
				"build",
				"-c", "Tools",
				`${this.path}/OpenDreamClient`,
			]),
		)));
		return {
			start: async (gamePort) => {
				return await startDedicatedTask(new Task(
					{ type: 'opendream_debug_client' },
					vscode.TaskScope.Workspace,
					TaskNames.RUN_CLIENT,
					TaskNames.SOURCE,
					new ProcessExecution("dotnet", [
						"run",
						"--no-build",  // because we built above
						"--project", `${this.path}/OpenDreamClient`,
						"--",
						"--connect",
						"--connect-address", `127.0.0.1:${gamePort}`,
					]),
				));
			}
		};
	}

	async startServer(params: { workspaceFolder?: vscode.WorkspaceFolder, debugPort: number, json_path: string }): Promise<void> {
		// Use executeTask instead of createTerminal so it will be readable if it crashes.
		await startDedicatedTask(new Task(
			{ type: 'opendream_debug_server' },
			params.workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.RUN_SERVER,
			TaskNames.SOURCE,
			new ProcessExecution("dotnet", [
				"run",
				"--project", `${this.path}/OpenDreamServer`,
				"-c", "Tools",
				"--",
				"--cvar", `server.port=0`,
				"--cvar", `opendream.debug_adapter_launched=${params.debugPort}`,
				"--cvar", `opendream.json_path=${params.json_path}`,
			]),
		));
	}
}

// OpenDream source code, also open in VSC. Can be debugged.
class ODWorkspaceFolderInstallation extends ODSourceInstallation {
	private workspaceFolder: vscode.WorkspaceFolder;

	constructor(workspaceFolder: vscode.WorkspaceFolder) {
		super(workspaceFolder.uri.fsPath);
		this.workspaceFolder = workspaceFolder;
	}

	async startServer(params: { workspaceFolder?: vscode.WorkspaceFolder | undefined; debugPort: number; json_path: string; }): Promise<void> {
		// Build, then run.
		await waitForTaskToEnd(await vscode.tasks.executeTask(new Task(
			{ type: 'opendream_debug_server' },
			this.workspaceFolder || vscode.TaskScope.Workspace,
			TaskNames.BUILD_SERVER,
			TaskNames.SOURCE,
			new ProcessExecution("dotnet", [
				"build",
				"-c", "Tools",
				`${this.path}/OpenDreamServer`,
			]),
		)));

		await vscode.debug.startDebugging(
			this.workspaceFolder,
			{
				name: "C#: OpenDream server",
				type: "coreclr",
				request: "launch",
				// No preLaunchTask since we do it manually above.
				program: "${workspaceFolder}/bin/Content.Server/OpenDreamServer",
				args: [
					"--cvar", `server.port=0`,
					"--cvar", `opendream.debug_adapter_launched=${params.debugPort}`,
					"--cvar", `opendream.json_path=${params.json_path}`,
				],
			}
		);
	}
}

function waitForTaskToEnd(task: vscode.TaskExecution): Promise<void> {
	return new Promise<void>(resolve => {
		let registration = vscode.tasks.onDidEndTask(event => {
			if (event.execution == task) {
				resolve();
				registration.dispose();
			}
		});
	});
}

function startDedicatedTask(task: vscode.Task): Thenable<vscode.TaskExecution> {
	task.presentationOptions.panel = vscode.TaskPanelKind.Dedicated;
	task.presentationOptions.showReuseMessage = false;
	return vscode.tasks.executeTask(task);
}
