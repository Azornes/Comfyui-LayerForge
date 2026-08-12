@echo off
echo Starting LayerForge build process...
robocopy src/css js/css /E /nfl /ndl /njh /njs > nul
robocopy src/templates js/templates /E /nfl /ndl /njh /njs > nul
echo Compiling TypeScript files...
call .\\node_modules\\.bin\\tsc.cmd
if %errorlevel% equ 0 (
    echo Build completed successfully - no errors found.
) else (
    echo Build failed with error code %errorlevel%.
)
echo Build process finished.
