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

%w[MainViewController.swift SharedLogPlugin.swift SharedStore.swift].each do |name|
  add_source(app, file_ref(app_group, name))
end
add_resource(app, file_ref(app_group, 'PrivacyInfo.xcprivacy'))
file_ref(app_group, 'App.entitlements')
app.build_configurations.each do |c|
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
end
puts '✓ App target: plugin, shared store, privacy manifest, entitlements'

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

project.save
