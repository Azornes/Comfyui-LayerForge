@echo off
echo Starting LayerForge build process...
robocopy src/css js/css /E /nfl /ndl /njh /njs > nul
robocopy src/templates js/templates /E /nfl /ndl /njh /njs > nul
echo Compiling TypeScript files...
call .\\node_modules\\.bin\\tsc.cmd
set BUILD_ERROR=%errorlevel%
if %BUILD_ERROR% equ 0 (
    echo Build completed successfully - no errors found.
) else (
    echo Build failed with error code %BUILD_ERROR%.
    exit /b %BUILD_ERROR%
)
echo Build process finished.
exit /b 0
