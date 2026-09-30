#!/usr/bin/env ruby
# Registers the repo's native iOS files with the Capacitor Xcode project.
# Idempotent: safe to run repeatedly. Requires the `xcodeproj` gem (ships with CocoaPods).
#
#   ruby native/ios/add-to-xcode.rb [ios/App/App.xcodeproj]

require 'xcodeproj'

proj_path = ARGV[0] || 'ios/App/App.xcodeproj'
project = Xcodeproj::Project.open(proj_path)

def file_ref(group, name)
  group.files.find { |f| f.path == name } || group.new_reference(name)
end

def add_source(target, ref)
  target.add_file_references([ref]) unless target.source_build_phase.files_references.include?(ref)
end

def add_resource(target, ref)
  target.add_resources([ref]) unless target.resources_build_phase.files_references.include?(ref)
end

app = project.targets.find { |t| t.name == 'App' } or abort('✗ App target not found')
app_group = project.main_group['App'] or abort('✗ App group not found')

%w[MainViewController.swift SharedLogPlugin.swift InAppBrowserPlugin.swift InAppBrowserViewController.swift SharedStore.swift].each do |name|
  add_source(app, file_ref(app_group, name))
end
add_resource(app, file_ref(app_group, 'PrivacyInfo.xcprivacy'))
file_ref(app_group, 'App.entitlements')
app.build_configurations.each do |c|
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
end
puts '✓ App target: plugins, in-app browser, shared store, privacy manifest, entitlements'

ext = project.targets.find { |t| t.name == 'Extension' }
if ext
  ext_group = project.main_group['Extension'] or abort('✗ Extension group not found (expected ios/App/Extension)')
  add_source(ext, file_ref(ext_group, 'SafariWebExtensionHandler.swift'))
  add_source(ext, file_ref(app_group, 'SharedStore.swift'))
  add_resource(ext, file_ref(ext_group, 'PrivacyInfo.xcprivacy'))
  file_ref(ext_group, 'Extension.entitlements')
  ext.build_configurations.each do |c|
    c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'Extension/Extension.entitlements'
    c.build_settings['INFOPLIST_FILE'] = 'Extension/Info.plist'
    c.build_settings['GENERATE_INFOPLIST_FILE'] = 'NO'
  end
  puts '✓ Extension target: handler, shared store, privacy manifest, entitlements, Info.plist'
else
  puts '… Extension target not found. Create it in Xcode (README, "iOS: add the Safari extension target"), then re-run.'
end

# Share extension ("Improve prompt"): created here if missing, so no Xcode clicks are needed.
share_dir = File.join(File.dirname(proj_path), 'ShareExtension')
if Dir.exist?(share_dir)
  share = project.targets.find { |t| t.name == 'ShareExtension' }
  unless share
    share = project.new_target(:app_extension, 'ShareExtension', :ios, '15.0', nil, :swift)
    app.add_dependency(share)
    embed = app.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins } ||
            app.new_copy_files_build_phase('Embed Foundation Extensions')
    embed.symbol_dst_subfolder_spec = :plug_ins
    build_file = embed.add_file_reference(share.product_reference, true)
    build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  end
  share_group = project.main_group['ShareExtension'] || project.main_group.new_group('ShareExtension', 'ShareExtension')
  add_source(share, file_ref(share_group, 'ShareViewController.swift'))
  add_resource(share, file_ref(share_group, 'coach.js'))
  add_resource(share, file_ref(share_group, 'PrivacyInfo.xcprivacy'))
  file_ref(share_group, 'Info.plist')
  app_id = app.build_configurations.first.build_settings['PRODUCT_BUNDLE_IDENTIFIER']
  app_cfg = app.build_configurations.first.build_settings
  share.build_configurations.each do |c|
    s = c.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = "#{app_id}.ShareExtension"
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['INFOPLIST_FILE'] = 'ShareExtension/Info.plist'
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['SWIFT_VERSION'] = '5.0'
    s['SKIP_INSTALL'] = 'YES'
    s['CODE_SIGN_STYLE'] = 'Automatic'
    s['MARKETING_VERSION'] = app_cfg['MARKETING_VERSION'] || '1.0'
    s['CURRENT_PROJECT_VERSION'] = app_cfg['CURRENT_PROJECT_VERSION'] || '1'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  end
  puts '✓ ShareExtension target: "Improve prompt" share action, coaching bundle, privacy manifest'
end

project.save
