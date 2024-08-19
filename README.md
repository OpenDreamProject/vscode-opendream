# OpenDream for Visual Studio Code

An extension for VSCode to add task runner and debugger support for
[OpenDream](https://github.com/OpenDreamProject/).

Best used in combination with [DreamMaker Language Client](https://marketplace.visualstudio.com/items?itemName=platymuus.dm-langclient).

## Features

- Full VSCode debugger integration (breakpoints, stepping, variable inspection, etc.)
- Automatic management of required binaries, including downloading releases from Github or compiling from source as appropriate
- Hot reloading of interface and resource files

## How To Use

Simply install the extension, open a folder containing your DME file, and start debugging. The extension will automatically grab the latest releases of OpenDream and the SS14 Launcher, compile your DME, start the server and the client and connect them.
Optionally, you can configure the path to your OpenDream source directory or add the OpenDream source directory to your workspace to compile from source instead.

## License

OpenDream for Visual Studio Code is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

OpenDream for Visual Studio Code is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with OpenDream for Visual Studio Code.  If not, see <http://www.gnu.org/licenses/>.
