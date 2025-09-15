# jdwp.ts

This library is intended to implement in typescript Java Debug Wire
Protocol (JDWP).
The high level interfaces of the library target directly Android JDWP
implementation, and are taught to be used in that context.

## Usage

A first test of the library can be done by installing the depencies first,
then with an Android device attached with ADB enabled you can use the test
node application with:

```bash
adb start-server # run adb in server mode
npm run cli
```

### WebUSB

Used out of the desktop context, the library has first class WebUSB
support, and it taught to be used without relying on a running adb
instance.
This library relies heavily on [Webadb](https://github.com/yume-chan/ya-webadb).
