# Create Android APK (for .NET MAUI, .NET 10)

dotnet publish -f net10.0-android -c Release /p:AndroidPackageFormat=apk /p:AndroidIdempotentBuilds=true
