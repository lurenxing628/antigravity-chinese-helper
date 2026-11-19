using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace AntigravityChineseHelper
{
    public sealed class RunnerStatus
    {
        public string Status { get; private set; }
        public int TranslatedWindows { get; private set; }
        public string LastError { get; private set; }

        public RunnerStatus(string status, int translatedWindows, string lastError)
        {
            if (string.IsNullOrEmpty(status))
            {
                throw new FormatException("Missing required field: status");
            }
            Status = status;
            TranslatedWindows = translatedWindows;
            LastError = lastError;
        }

        public string MenuTitle
        {
            get
            {
                if (Status == "error")
                {
                    return "汉化遇到问题：" + (string.IsNullOrEmpty(LastError) ? "打开说明查看日志" : LastError);
                }
                if (Status == "stopped")
                {
                    return "汉化助手已停止";
                }
                if (TranslatedWindows > 0)
                {
                    return "已汉化 " + TranslatedWindows + " 个窗口";
                }
                if (Status == "waiting" || Status == "running")
                {
                    return "运行中 · 等待 Antigravity 窗口";
                }
                return "汉化运行中";
            }
        }

        public static RunnerStatus Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                throw new FormatException("Empty status JSON");
            }
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> root = serializer.DeserializeObject(json) as Dictionary<string, object>;
            if (root == null)
            {
                throw new FormatException("Status payload must be a JSON object");
            }
            object rawStatus;
            object rawWindows;
            if (!root.TryGetValue("status", out rawStatus) || !(rawStatus is string))
            {
                throw new FormatException("Missing required string field: status");
            }
            if (!root.TryGetValue("translatedWindows", out rawWindows) || rawWindows == null)
            {
                throw new FormatException("Missing required integer field: translatedWindows");
            }
            int translatedWindows;
            if (rawWindows is int)
            {
                translatedWindows = (int)rawWindows;
            }
            else if (rawWindows is long)
            {
                translatedWindows = Convert.ToInt32((long)rawWindows);
            }
            else
            {
                throw new FormatException("translatedWindows must be an integer");
            }

            string lastError = null;
            object rawError;
            if (root.TryGetValue("lastError", out rawError) && rawError is string)
            {
                lastError = (string)rawError;
            }
            return new RunnerStatus((string)rawStatus, translatedWindows, lastError);
        }
    }

    public sealed class LaunchReply
    {
        public bool Launched { get; private set; }
        public string Message { get; private set; }

        public LaunchReply(bool launched, string message)
        {
            Launched = launched;
            Message = message ?? string.Empty;
        }

        public static LaunchReply TryParse(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return null;
            }
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> root = serializer.DeserializeObject(json) as Dictionary<string, object>;
                if (root == null)
                {
                    return null;
                }
                object rawLaunched;
                if (!root.TryGetValue("launched", out rawLaunched) || !(rawLaunched is bool))
                {
                    return null;
                }
                string message = string.Empty;
                object rawMessage;
                if (root.TryGetValue("message", out rawMessage) && rawMessage is string)
                {
                    message = (string)rawMessage;
                }
                return new LaunchReply((bool)rawLaunched, message);
            }
            catch
            {
                return null;
            }
        }
    }
}
