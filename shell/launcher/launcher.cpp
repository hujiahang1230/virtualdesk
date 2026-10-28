// VirtualDesk · 原生启动器
//
// 为什么需要它:
//   .NET 的"单文件"发布在以下两种情况会把内容解压到磁盘:
//     - 包含原生库(IncludeNativeLibrariesForSelfExtract,SQLite 需要)
//     - 启用了单文件压缩(EnableCompressionInSingleFile)
//   默认解压位置是 %TEMP%\.net\<应用名>。而 %TEMP% 在某些受控环境里
//   连目录都建不出来,表现为:
//     Failure processing application bundle.
//     Failed to create directory [...\Temp\.net\VirtualDesk\] Error code: 5
//
//   托管代码里的任何设置都来不及生效 —— 这份解压发生在托管代码运行之前。
//   所以必须由一个原生小启动器先设好 DOTNET_BUNDLE_EXTRACT_BASE_DIR,
//   再拉起真正的程序。
//
// 这个启动器不做别的:定位一个可写的解压目录 → 拉起内部 exe → 透传退出码。

// 必须用宽字符 API:路径里会有中文
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601

#include <windows.h>
#include <shellapi.h>   // CommandLineToArgvW
#include <shlobj.h>     // SHGetFolderPathW
#include <cwchar>       // swprintf_s
#include <string>
#include <vector>

namespace {

constexpr const wchar_t* kInnerExeName = L"virtualdesk-core.exe";
constexpr const wchar_t* kAppFolder = L"virtualdesk-data";

/// 把一个宽字符串写入文件并删除,用来判断目录是否真的可写。
///
/// 注意必须用 SHCreateDirectoryExW 递归创建:CreateDirectoryW 只创建最后一级,
/// 中间目录不存在时直接返回 ERROR_PATH_NOT_FOUND(错误码 3)。
/// reason 会带上失败原因,方便在启动器日志里定位。
bool IsWritable(const std::wstring& dir, std::wstring* reason = nullptr) {
    const int created = SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
    if (created != ERROR_SUCCESS && created != ERROR_ALREADY_EXISTS &&
        created != ERROR_FILE_EXISTS) {
        if (reason) {
            *reason = L"创建目录失败,错误码 " + std::to_wstring(created);
        }
        return false;
    }

    wchar_t probePath[MAX_PATH];
    swprintf_s(probePath, L"%s\\.probe-%lu", dir.c_str(), GetCurrentProcessId());

    HANDLE file = CreateFileW(probePath, GENERIC_WRITE, 0, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        if (reason) {
            *reason = L"写入测试文件失败,错误码 " + std::to_wstring(GetLastError());
        }
        return false;
    }

    CloseHandle(file);
    DeleteFileW(probePath);
    return true;
}

std::wstring ExeDirectory() {
    wchar_t buffer[MAX_PATH];
    const DWORD length = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    std::wstring path(buffer, length);

    const size_t slash = path.find_last_of(L'\\');
    return slash == std::wstring::npos ? L"." : path.substr(0, slash);
}

/// 依次尝试几个位置,返回第一个真正可写的;记录每个候选的尝试结果
std::wstring ResolveExtractDir(const std::wstring& exeDir, std::wstring* report = nullptr) {
    std::vector<std::wstring> candidates;

    // 1) 环境变量显式指定
    wchar_t override_[MAX_PATH];
    if (GetEnvironmentVariableW(L"VD_EXTRACT_DIR", override_, MAX_PATH) > 0) {
        candidates.emplace_back(override_);
    }

    // 2) exe 同级 —— 免安装程序的自然选择
    candidates.push_back(exeDir + L"\\" + kAppFolder + L"\\dotnet");
    candidates.push_back(exeDir + L"\\VirtualDesk-data\\dotnet");

    // 3) 用户目录
    wchar_t localAppData[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, localAppData))) {
        candidates.push_back(std::wstring(localAppData) + L"\\VirtualDesk\\dotnet");
    }

    std::wstring lines;
    for (const auto& candidate : candidates) {
        std::wstring reason;
        if (IsWritable(candidate, &reason)) {
            lines += L"  [可写] " + candidate + L"\r\n";
            if (report) *report = lines;
            return candidate;
        }
        lines += L"  [不可写] " + candidate + L" —— " + reason + L"\r\n";
    }

    if (report) *report = lines;
    return L"";  // 都不行,交给 .NET 自己的默认逻辑
}

void ShowError(const std::wstring& text) {
    MessageBoxW(nullptr, text.c_str(), L"VirtualDesk 启动失败", MB_OK | MB_ICONERROR);
}

/// 诊断输出:既写 AttachConsole 拿到的控制台,也写文件,
/// 因为单文件版的启动器是 GUI 子系统,没有自己的控制台窗口。
void Trace(const std::wstring& directory, const std::wstring& message) {
    if (!directory.empty()) {
        const std::wstring path = directory + L"\\启动器日志.txt";
        HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ,
                                  nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE) {
            std::wstring line = message + L"\r\n";
            // 写 UTF-8,避免中文在记事本里乱码
            int size = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(),
                                           nullptr, 0, nullptr, nullptr);
            if (size > 0) {
                std::string utf8(size, '\0');
                WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(),
                                    utf8.data(), size, nullptr, nullptr);
                DWORD written = 0;
                WriteFile(file, utf8.data(), (DWORD)utf8.size(), &written, nullptr);
            }
            CloseHandle(file);
        }
    }
}

}  // namespace

int wmain() {
    const std::wstring exeDir = ExeDirectory();
    const std::wstring innerExe = exeDir + L"\\" + kInnerExeName;
    // 日志目录:优先 exe 同级,写不进去就放弃(不能让日志本身阻断启动)
    std::wstring logDir = exeDir;
    if (!IsWritable(logDir)) logDir.clear();

    Trace(logDir, L"启动器开始,exe 目录 = " + exeDir);

    if (GetFileAttributesW(innerExe.c_str()) == INVALID_FILE_ATTRIBUTES) {
        Trace(logDir, L"找不到主程序:" + innerExe);
        ShowError(L"找不到主程序:\n" + innerExe +
                  L"\n\n请确认解压时没有丢文件,或重新下载完整压缩包。");
        return 1;
    }

    std::wstring extractReport;
    const std::wstring extractDir = ResolveExtractDir(exeDir, &extractReport);
    Trace(logDir, L"解压目录候选:\r\n" + extractReport);
    Trace(logDir, extractDir.empty()
                      ? L"没有可写解压目录,交给 .NET 默认逻辑(很可能失败)"
                      : L"选定解压目录 = " + extractDir);

    if (!extractDir.empty()) {
        if (!SetEnvironmentVariableW(L"DOTNET_BUNDLE_EXTRACT_BASE_DIR", extractDir.c_str())) {
            Trace(logDir, L"设置 DOTNET_BUNDLE_EXTRACT_BASE_DIR 失败,错误码 "
                              + std::to_wstring(GetLastError()));
        }
    }

    // 临时目录也必须指向可写位置。
    // .NET / WinForms 会在 %TEMP% 里建文件(例如 EnableVisualStyles 要写一个 manifest),
    // %TEMP% 不可写时程序会在启动最初期就抛 UnauthorizedAccessException。
    // 这里把 TEMP/TMP 也改到我们确认过可写的地方,子进程会继承。
    std::wstring tempDir;
    if (!extractDir.empty()) {
        // extractDir 形如 <可写根>\dotnet,取它的上一级作为临时目录
        const size_t slash = extractDir.find_last_of(L'\\');
        if (slash != std::wstring::npos) tempDir = extractDir.substr(0, slash);
    }
    if (tempDir.empty() || !IsWritable(tempDir)) {
        std::wstring reason;
        tempDir = exeDir + L"\\VirtualDesk-data";
        if (!IsWritable(tempDir, &reason)) {
            Trace(logDir, L"找不到可写临时目录,保留系统 TEMP:" + reason);
            tempDir.clear();
        }
    }
    if (!tempDir.empty()) {
        SetEnvironmentVariableW(L"TEMP", tempDir.c_str());
        SetEnvironmentVariableW(L"TMP", tempDir.c_str());
        Trace(logDir, L"临时目录 = " + tempDir);
    }

    // 组装命令行:透传启动器收到的所有参数
    std::wstring commandLine = L"\"" + innerExe + L"\"";
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv != nullptr) {
        for (int i = 1; i < argc; ++i) {
            commandLine += L" \"";
            commandLine += argv[i];
            commandLine += L"\"";
        }
        LocalFree(argv);
    }

    Trace(logDir, L"即将启动:" + commandLine);

    STARTUPINFOW startupInfo{};
    startupInfo.cb = sizeof(startupInfo);
    PROCESS_INFORMATION processInfo{};

    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');

    const BOOL started = CreateProcessW(
        innerExe.c_str(),   // lpApplicationName
        mutableCommand.data(),  // lpCommandLine
        nullptr,            // lpProcessAttributes
        nullptr,            // lpThreadAttributes
        FALSE,              // bInheritHandles:不继承句柄
        0,                  // dwCreationFlags
        nullptr,            // lpEnvironment:nullptr = 继承启动器的环境
        exeDir.c_str(),     // lpCurrentDirectory
        &startupInfo,       // lpStartupInfo
        &processInfo);      // lpProcessInformation

    if (!started) {
        const DWORD error = GetLastError();
        Trace(logDir, L"CreateProcess 失败,错误码 " + std::to_wstring(error));
        ShowError(L"无法启动主程序(错误码 " + std::to_wstring(error) + L"):\n" + innerExe);
        return 1;
    }

    Trace(logDir, L"内部进程已创建,PID " + std::to_wstring(processInfo.dwProcessId));

    // 内部程序是 GUI,启动器等它退出以便透传退出码
    CloseHandle(processInfo.hThread);
    WaitForSingleObject(processInfo.hProcess, INFINITE);

    DWORD exitCode = 0;
    GetExitCodeProcess(processInfo.hProcess, &exitCode);
    CloseHandle(processInfo.hProcess);

    Trace(logDir, L"内部进程已退出,退出码 " + std::to_wstring(exitCode));
    return static_cast<int>(exitCode);
}
