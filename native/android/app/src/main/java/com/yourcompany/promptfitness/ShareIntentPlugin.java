package com.yourcompany.promptfitness;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives text shared into the app (ACTION_SEND, text/plain) and hands it to the web layer.
 * The text is only analyzed in memory; the app never stores it.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

    private static final int MAX_CHARS = 20000;

    /** Text the app was launched with (cold start). Consumed so a reload doesn't re-import it. */
    @PluginMethod
    public void getSharedText(PluginCall call) {
        JSObject ret = new JSObject();
        Intent intent = getActivity().getIntent();
        String text = extract(intent);
        if (text != null) {
            ret.put("text", text);
            intent.removeExtra(Intent.EXTRA_TEXT);
            intent.setAction(Intent.ACTION_MAIN);
        }
        call.resolve(ret);
    }

    /** Text shared while the app is already running (singleTask). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = extract(intent);
        if (text != null) {
            JSObject data = new JSObject();
            data.put("text", text);
            notifyListeners("shared", data, true);
        }
    }

    private static String extract(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/plain")) return null;
        CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (cs == null) return null;
        String s = cs.toString();
        if (s.trim().isEmpty()) return null;
        return s.length() > MAX_CHARS ? s.substring(0, MAX_CHARS) : s;
    }
}
