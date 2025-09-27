// 全局变量
var k = 0; // 已读消息计数
var version = 0; // 消息版本号
var c; // 消息轮询定时器
var h; // 心跳定时器
var name = "";
var key = "";
var isSending = false; // 发送状态锁
var chatUsers = []; // 全局用户列表
var userColors = {}; // 用户颜色缓存
var heartbeatInterval = 60000; // 心跳间隔60秒

// 私聊系统状态
var currentView = 'group'; // 'group', 'private-dropdown', 'private-chat'
var currentChatId = null; // 当前私聊ID
var privateChatsData = {}; // 私聊数据缓存
var lastPrivateCheck = 0; // 上次检查私聊的时间
var isPrivateDropdownOpen = false; // 私聊下拉列表是否打开
var privateChatWindow = null; // 私聊窗口状态
var privateDropdownPersistent = false; // 私聊列表是否持久化显示
var privateChatNotifications = {}; // 私聊新消息通知状态

// 自适应轮询配置
var pollingConfig = {
    minInterval: 1000,    // 最小轮询间隔1秒
    maxInterval: 10000,   // 最大轮询间隔10秒
    currentInterval: 2000, // 当前轮询间隔
    lastMessageTime: 0,   // 上次收到消息的时间
    consecutiveEmptyResponses: 0, // 连续空响应次数
    isActive: true        // 用户是否活跃
};

// 调整轮询间隔的策略
function adjustPollingInterval(hasNewMessages) {
    var now = Date.now();
    
    if (hasNewMessages) {
        // 有新消息时，加快轮询
        pollingConfig.consecutiveEmptyResponses = 0;
        pollingConfig.lastMessageTime = now;
        pollingConfig.currentInterval = Math.max(
            pollingConfig.minInterval,
            pollingConfig.currentInterval * 0.8
        );
    } else {
        // 没有新消息时，逐渐减慢轮询
        pollingConfig.consecutiveEmptyResponses++;
        
        // 如果用户不活跃且连续多次没有新消息，降低轮询频率
        var timeSinceLastMessage = now - pollingConfig.lastMessageTime;
        if (timeSinceLastMessage > 30000 && pollingConfig.consecutiveEmptyResponses > 3) {
            pollingConfig.currentInterval = Math.min(
                pollingConfig.maxInterval,
                pollingConfig.currentInterval * 1.5
            );
        }
    }
    
    // 重启轮询定时器
    if (c) {
        clearInterval(c);
        c = setInterval(get_msg, pollingConfig.currentInterval);
    }
}

// 检测用户活跃状态
function updateUserActivity() {
    pollingConfig.isActive = true;
    pollingConfig.lastActivityTime = Date.now();
    
    // 用户活跃时恢复正常轮询间隔
    if (pollingConfig.currentInterval > pollingConfig.minInterval * 2) {
        pollingConfig.currentInterval = pollingConfig.minInterval * 2;
        if (c) {
            clearInterval(c);
            c = setInterval(get_msg, pollingConfig.currentInterval);
        }
    }
}

// 生成随机浅色
function getRandomLightColor() {
    const h = Math.floor(Math.random() * 360);
    const s = Math.floor(Math.random() * 30) + 30; // 饱和度30%-60%
    const l = Math.floor(Math.random() * 20) + 70; // 亮度70%-90%
    return `hsl(${h}, ${s}%, ${l}%)`;
}

$(document).ready(function() {
    // 绑定事件
    $('#login-btn').on("click", login);
    $("#send-btn").on("click", send);
    $("#upload-btn").on("click", function() {
        $("#file-input").click();
    });
    
    
    
    // 文件选择事件
    $("#file-input").on("change", function() {
        var files = this.files;
        if (files.length > 0) {
            uploadFiles(files);
        }
    });
    
    $("#msg").on("keypress", function(e) {
        if (e.keyCode == 13) {
            send();
            return false;
        }
    });

    

    // 显示/隐藏管理员密码框
    $("#nick").on("input", function() {
        if ($(this).val() === 'admin') {
            $("#pwd").show();
        } else {
            $("#pwd").hide();
        }
    });
    
    // 监听用户活动
    $(document).on('click keypress scroll', function() {
        updateUserActivity();
    });
    
    // 图片点击查看大图
    $(document).on('click', '.image-preview', function() {
        var src = $(this).attr('src');
        openImageModal(src);
    });
    
    // 头像点击事件处理
    $(document).on('click', '.avatar', function(e) {
        e.stopPropagation();
        var $msg = $(this).closest('.msg');
        var username = $msg.find('.username').text();
        if (username && username !== name) { // 不能对自己操作
            showAvatarMenu(e, username);
        }
    });
    
    // 用户列表下拉菜单
    $('#msg').on('focus', function() {
        if (chatUsers.length > 0) {
            showUserList();
        }
    }).on('blur', function() {
        setTimeout(function() {
            $('#user-list').remove();
        }, 200);
    });
    
    // 绑定返回按钮
    $('#back-btn').on('click', function() {
        // 直接退出登录
        logoutUser();
        $('#chat-section').hide();
        $('#back-btn').hide();
        $('#login-section').show();
        
        if (c) {
            clearInterval(c);
            c = null;
        }
        
        if (h) {
            clearInterval(h);
            h = null;
        }
        
        $('#chat-box').empty();
        name = "";
        key = "";
        currentView = 'group';
    });
    
    // 点击其他地方隐藏头像菜单
    $(document).on('click', function(e) {
        if (!$(e.target).closest('#avatar-menu').length && !$(e.target).hasClass('avatar')) {
            $('#avatar-menu').hide();
        }
    });
    
    // 页面关闭事件监听
    window.addEventListener('beforeunload', function() {
        if (name && key) {
            logoutUser();
        }
    });
});

function sockll() {
    var chatBox = $("#chat-box")[0];
    chatBox.scrollTop = chatBox.scrollHeight;
}

// 发送心跳
function sendHeartbeat() {
    $.post("/heartbeat", {}, function() {}, "json");
}

// 用户退出
function logoutUser() {
    if (name && key) {
        $.post("/logout", {}, function() {}, "json");
    }
}

function send() {
    if (isSending) return;
    
    var msg = $("#msg").val().trim();
    if (!msg) return false;
    
    // 群聊消息发送
    isSending = true;
    
    $.post("/send", {msg: msg}, function(data) {
        isSending = false;
        
        // 检查是否是管理员清空操作
        if (data.admin_clear) {
            // 管理员清空了所有内容，处理私聊清空
            handleAdminClearAll();
            // 清空输入框
            $("#msg").val("");
            // 管理员清空后不需要继续执行其他操作
            return;
        }
        
        // 移除了私聊列表控制命令处理，改为双击屏幕唤起
        
        // 直接更新版本号，不强制刷新
        if (data.version) {
            version = data.version;
        }
        
        $("#msg").val("");
        $("#msg").focus();
    }, "json").fail(function() {
        isSending = false;
        addtip('消息发送失败', 'tips-warning');
    });
}

// 管理员清空标志 - 防止其他检查函数干扰
var adminClearInProgress = false;

// 处理管理员清空所有内容
function handleAdminClearAll() {
    // 设置管理员清空标志，防止其他检查函数显示错误弹窗
    adminClearInProgress = true;
    
    // 1. 强制回到群聊视图
    currentView = 'group';
    
    // 2. 如果有私聊窗口打开，强制关闭它（不显示弹窗）
    if (privateChatWindow && privateChatWindow.isOpen) {
        closePrivateChat();
    }
    
    // 3. 关闭私聊列表
    privateDropdownPersistent = false;
    closePrivateDropdown('manual');
    
    // 4. 清空私聊相关数据
    privateChatsData = {};
    privateChatNotifications = {};
    currentChatId = null;
    privateChatWindow = null;
    
    // 5. 停止所有私聊相关定时器
    if (window.privateChatStatusTimer) {
        clearInterval(window.privateChatStatusTimer);
        window.privateChatStatusTimer = null;
    }
    
    // 6. 清除所有模态框和弹窗
    $('.chat-destroyed-modal').remove();
    $('.private-invite-modal').remove();
    $('#image-modal').hide();
    
    // 7. 隐藏所有私聊相关界面
    $('#private-chat-window').hide();
    $('#private-dropdown').hide();
    $('#private-chat-indicator').hide();
    
    // 8. 清空管理员自己的聊天界面
    $('#chat-box').empty();
    k = 0; // 重置消息计数
    
    // 9. 延迟重置标志，确保所有检查都完成
    setTimeout(function() {
        adminClearInProgress = false;
    }, 1000);
}

// 私聊相关交互已移除

// 旧的sendPrivateMessage函数已被新版本替代

// 旧的视图切换函数已被删除，使用新的私聊下拉列表和弹窗系统

// 旧的loadPrivateMessages函数已被新版本替代

// 销毁私聊
function destroyPrivateChat(chatId) {
    if (confirm('确定要销毁这个私聊吗？聊天内容将被永久删除。')) {
        $.ajax({
            url: '/private/exit',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({chat_id: chatId}),
            success: function(data) {
                if (data.result === 'success') {
                    // 如果当前在此私聊窗口中，关闭窗口
                    if (currentChatId === chatId) {
                        closePrivateChat();
                        // 显示私聊列表
                        if (!isPrivateDropdownOpen) {
                            privateDropdownPersistent = true;
                            openPrivateDropdown();
                        }
                    }
                    // 清除通知
                    if (privateChatNotifications[chatId]) {
                        delete privateChatNotifications[chatId];
                    }
                    // 显示销毁成功提示
                    showChatDestroyedDialog('您已销毁私聊');
                    // 刷新私聊下拉列表
                    checkPrivateChats();
                    if (isPrivateDropdownOpen) {
                        displayPrivateChatDropdown();
                    }
                }
            }
        });
    }
}

// 显示私聊被销毁的对话框
function showChatDestroyedDialog(message) {
    // 如果管理员清空操作进行中，不显示任何弹窗
    if (adminClearInProgress) {
        return;
    }
    
    var modalHtml = `
        <div class="chat-destroyed-modal">
            <div class="chat-destroyed-content">
                <h3>💥 私聊已销毁</h3>
                <p>${message}</p>
                <div class="chat-destroyed-buttons">
                    <button class="btn-confirm" onclick="confirmChatDestroyed()">确认</button>
                </div>
            </div>
        </div>
    `;
    
    // 移除已存在的弹窗
    $('.chat-destroyed-modal').remove();
    
    // 添加新的弹窗
    $('body').append(modalHtml);
    $('.chat-destroyed-modal').fadeIn(300);
}

// 移除了管理员清空弹窗，改为直接在公共区域广播

// 确认私聊被销毁
function confirmChatDestroyed() {
    $('.chat-destroyed-modal').fadeOut(300, function() {
        $(this).remove();
    });
}

// 检测对方是否退出私聊
function checkPrivateChatStatus() {
    if (privateChatWindow && privateChatWindow.isOpen && currentChatId) {
        // 检查当前私聊是否还存在
        var chatExists = false;
        if (privateChatsData && privateChatsData.length > 0) {
            chatExists = privateChatsData.some(function(chat) {
                return chat.chat_id === currentChatId;
            });
        }
        
        // 如果私聊不存在了，说明对方已离线或销毁了私聊
        if (!chatExists) {
            // 如果是管理员清空操作进行中，不显示对方离线弹窗
            if (!adminClearInProgress) {
                showChatDestroyedDialog('💔 对方已离线，私聊已结束');
            }
            // 关闭当前私聊窗口
            closePrivateChat();
        }
    }
}

// 强制检查私聊状态（用于实时监控）
function forceCheckPrivateChatStatus() {
    if (privateChatWindow && privateChatWindow.isOpen && currentChatId) {
        $.getJSON('/private/chats', function(data) {
            if (data.result === 'success') {
                var chatExists = false;
                if (data.active_chats && data.active_chats.length > 0) {
                    chatExists = data.active_chats.some(function(chat) {
                        return chat.chat_id === currentChatId;
                    });
                }
                
                // 如果私聊不存在了，立即销毁
                if (!chatExists) {
                    // 如果是管理员清空操作进行中，不显示对方离线弹窗
                    if (!adminClearInProgress) {
                        showChatDestroyedDialog('💔 对方已离线，私聊已结束');
                    }
                    closePrivateChat();
                }
            }
        }).fail(function() {
            // 网络错误也销毁私聊
            // 如果是管理员清空操作进行中，不显示网络错误弹窗
            if (!adminClearInProgress) {
                showChatDestroyedDialog('💔 网络连接已断开，私聊已结束');
            }
            closePrivateChat();
        });
    }
}

// 旧的对方退出对话框函数已删除，使用showChatDestroyedDialog替代

function addtip(text, className) {
    $('#chat-box').append(
        '<div class="tips ' + (className || '') + '">' + text + '</div>'
    );
    sockll();
}

function addmsg(username, message, position, isSelf, timestamp, messageType) {
    var selfClass = isSelf ? ' self-msg' : '';
    var firstChar = username.charAt(0).toUpperCase();
    
    if (!userColors[username]) {
        userColors[username] = getRandomLightColor();
    }
    var avatarColor = userColors[username];
    
    var timestampHtml = '';
    if (timestamp) {
        timestampHtml = '<div class="timestamp">' + timestamp + '</div>';
    }
    
    // 处理不同类型的消息
    var messageContent = message;
    if (messageType === 'text' || !messageType) {
        // 处理普通文本消息中的链接
        messageContent = convertLinksToHtml(message);
    } else if (messageType === 'file') {
        // 文件消息直接使用传入的HTML
        messageContent = message;
    }
    
    var msgHtml = '<div class="msg ' + position + selfClass + '">' +
        '<div class="msg-content">' +
        '<div class="avatar" style="background-color:' + avatarColor + '">' + firstChar + '</div>' +
        '<div class="msg-body">' +
        '<div class="username">' + username + '</div>' +
        '<div class="message">' + messageContent + '</div>' +
        timestampHtml +
        '</div>' +
        '</div>' +
        '</div>';
    
    $('#chat-box').append(msgHtml);
    sockll();
}

// 将文本中的链接转换为HTML链接
function convertLinksToHtml(text) {
    // URL正则表达式
    var urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, '<a href="$1" target="_blank">$1</a>');
}

// 文件上传函数
function uploadFiles(files) {
    if (isSending) return;
    
    // 群聊文件上传
    isSending = true;
    $('#upload-btn').text('↑').prop('disabled', true);
    
    var formData = new FormData();
    for (var i = 0; i < files.length; i++) {
        formData.append('files[]', files[i]);
    }
    
    $.ajax({
        url: '/upload',
        type: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        success: function(data) {
            isSending = false;
            $('#upload-btn').text('+').prop('disabled', false);
            
            if (data.result === 'success') {
                // 直接更新版本号，不强制刷新
                if (data.version) {
                    version = data.version;
                }
            } else {
                addtip('文件上传失败：' + (data.message || '未知错误'), 'tips-warning');
            }
            
            // 清空文件选择
            $('#file-input').val('');
        },
        error: function() {
            isSending = false;
            $('#upload-btn').text('+').prop('disabled', false);
            addtip('文件上传失败，请重试', 'tips-warning');
            $('#file-input').val('');
        }
    });
}

// 获取文件类型
function getFileType(fileName) {
    var ext = fileName.split('.').pop().toLowerCase();
    
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
        return 'image';
    } else if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm'].includes(ext)) {
        return 'video';
    } else if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) {
        return 'audio';
    } else if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) {
        return 'document';
    } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
        return 'archive';
    } else {
        return 'other';
    }
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    var k = 1024;
    var sizes = ['Bytes', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 生成文件HTML
function generateFileHtml(fileInfo) {
    var fileType = getFileType(fileInfo.name);
    var fileTypeText = fileType.toUpperCase();
    
    if (fileType === 'image') {
        // 图片直接显示预览
        return '<div class="file-message">' +
               '<img src="/uploads/' + fileInfo.filename + '" alt="' + fileInfo.name + '" class="image-preview">' +
               '<div class="file-info" style="margin-top: 5px;">' +
               '<div class="file-name">' + fileInfo.name + '</div>' +
               '<div class="file-size">' + formatFileSize(fileInfo.size) + '</div>' +
               '</div>' +
               '</div>';
    } else {
        // 其他文件显示为文件框
        return '<div class="file-message">' +
               '<div class="file-item">' +
               '<div class="file-icon ' + fileType + '">' + fileTypeText + '</div>' +
               '<div class="file-info">' +
               '<a href="/uploads/' + fileInfo.filename + '" class="file-link" target="_blank">' +
               '<div class="file-name">' + fileInfo.name + '</div>' +
               '</a>' +
               '<div class="file-size">' + formatFileSize(fileInfo.size) + '</div>' +
               '</div>' +
               '</div>' +
               '</div>';
    }
}

// 图片模态框功能
function openImageModal(src) {
    $('#modal-image').attr('src', src);
    $('#image-modal').fadeIn(300);
    $('body').css('overflow', 'hidden'); // 禁止背景滚动
}

function closeImageModal() {
    $('#image-modal').fadeOut(300);
    $('body').css('overflow', 'auto'); // 恢复滚动
}

// ESC键关闭模态框
$(document).keydown(function(e) {
    if (e.keyCode == 27) { // ESC键
        closeImageModal();
    }
});

// 点击背景关闭模态框
$(document).on('click', '#image-modal', function(e) {
    if (e.target === this) {
        closeImageModal();
    }
});

// 私聊邀请与列表逻辑已移除

function get_msg() {
    // 仅群聊逻辑
    
    $.getJSON("/msg?k=" + k + "&v=" + version, function(data) {
        if (data.reset) {
            // 管理员清屏或版本不匹配，强制刷新群聊
            // 设置管理员清空标志，防止显示对方离线弹窗
            adminClearInProgress = true;
            
            handleVersionChange(data.version);
            
            // 强制回到群聊视图
            currentView = 'group';
            
            // 清理界面
            $('#image-modal').hide();
            
            // 延迟重置标志，确保所有检查都完成
            setTimeout(function() {
                adminClearInProgress = false;
            }, 1000);
            
            get_msg();
            return;
        }
        
        if (data.version) {
            version = data.version;
        }
        
        if (data.list && data.list.length > 0) {
            k = data.count;
            
            // 群聊模式下正常显示消息
            $.each(data.list, function(index, msgJson) {
                try {
                    var msg = JSON.parse(msgJson);
                    if (msg.type === 'sys') {
                        addtip(msg.msg, 'tips-warning');
                    } else if (msg.type === 'file') {
                        // 处理文件消息
                        var isSelf = (msg.key === key);
                        var position = isSelf ? "right" : "left";
                        var timestamp = msg.timestamp ? msg.timestamp : "";
                        var fileHtml = generateFileHtml(msg.fileInfo);
                        addmsg(msg.name, fileHtml, position, isSelf, timestamp, 'file');
                    } else {
                        // 处理普通文本消息
                        var isSelf = (msg.key === key);
                        var position = isSelf ? "right" : "left";
                        var timestamp = msg.timestamp ? msg.timestamp : "";
                        addmsg(msg.name, msg.msg, position, isSelf, timestamp, 'text');
                    }
                } catch (e) {
                    console.error("Error parsing message:", e);
                }
            });
            sockll();
        }
        
        if (data.users) {
            chatUsers = Array.from(new Set(data.users));
        }
        adjustPollingInterval(data.list && data.list.length > 0); // 根据是否有新消息调整轮询间隔
    }).fail(function(xhr, status, error) {
        // 网络错误时暂停轮询，并提供重试选项
        clearInterval(c);
        
        // 根据错误类型提供不同的提示
        var errorMsg = '消息获取失败';
        if (status === 'timeout') {
            errorMsg = '请求超时';
        } else if (xhr.status === 0) {
            errorMsg = '网络连接异常';
        } else if (xhr.status >= 500) {
            errorMsg = '服务器错误';
        }
        
        addtip(errorMsg + '，<a id="fresh" href="javascript:;">点击重试</a>', 'tips-warning');
        $('#fresh').on('click', function() {
            // 重置轮询配置
            pollingConfig.currentInterval = 2000;
            pollingConfig.consecutiveEmptyResponses = 0;
            
            get_msg();
            c = setInterval(get_msg, pollingConfig.currentInterval);
        });
    });
}

// 处理服务器要求的强制刷新（仅在管理员清屏等特殊情况下调用）
function handleVersionChange(newVersion) {
    $('#chat-box').empty();
    k = 0;
    version = newVersion;
    addtip('聊天记录已刷新', 'tips-warning');
}

// 显示头像菜单
function showAvatarMenu(event, username) {
    // 隐藏可能存在的菜单
    $('#avatar-menu').hide();
    
    // 设置菜单位置
    var x = event.pageX;
    var y = event.pageY;
    
    // 调整菜单位置，防止超出屏幕
    var menuWidth = 120;
    var menuHeight = 80;
    var windowWidth = $(window).width();
    var windowHeight = $(window).height();
    
    if (x + menuWidth > windowWidth) {
        x = windowWidth - menuWidth - 10;
    }
    if (y + menuHeight > windowHeight) {
        y = y - menuHeight - 10;
    }
    
    // 显示菜单
    $('#avatar-menu').css({
        left: x + 'px',
        top: y + 'px'
    }).show();
    
    // 绑定菜单项点击事件
    $('#avatar-menu .avatar-menu-item').off('click').on('click', function() {
        var action = $(this).data('action');
        handleAvatarAction(action, username);
        $('#avatar-menu').hide();
    });
}

// 处理头像菜单操作（仅保留@ 提及）
function handleAvatarAction(action, username) {
    if (action === 'mention') {
        var currentMsg = $('#msg').val();
        var newMsg = currentMsg.trim();
        if (newMsg !== '' && !newMsg.endsWith(' ')) {
            newMsg += ' ';
        }
        newMsg += '@' + username + ' ';
        $('#msg').val(newMsg).focus();
    }
}

// 点击其他地方隐藏菜单
$(document).on('click', function(e) {
    if (!$(e.target).closest('#avatar-menu').length && !$(e.target).hasClass('avatar')) {
        $('#avatar-menu').hide();
    }
});

// 显示用户列表
function showUserList() {
    $('#user-list').remove();
    
    var $input = $('#msg');
    var position = $input.offset();
    
    var $userList = $('<div id="user-list"></div>')
        .css({
            position: 'absolute',
            top: position.top + $input.outerHeight() + 5,
            left: position.left,
            width: $input.outerWidth(),
            maxHeight: '200px',
            overflowY: 'auto',
            backgroundColor: '#fff',
            border: '1px solid #ddd',
            borderRadius: '5px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
            zIndex: 1000
        });
    
    chatUsers.forEach(function(user) {
        if (user === name) return;
        
        $('<div class="user-item">@' + user + '</div>')
            .css({
                padding: '8px 12px',
                cursor: 'pointer',
                borderBottom: '1px solid #eee'
            })
            .hover(
                function() { $(this).css('background-color', '#f5f6f7'); },
                function() { $(this).css('background-color', '#fff'); }
            )
            .click(function() {
                handleAvatarClick(user);
                $userList.remove();
            })
            .appendTo($userList);
    });
    
    $('body').append($userList);
}

function login() {
    var nickname = $('#nick').val().trim();
    var password = '';
    
    if (nickname === 'admin') {
        password = $('#pwd').val();
    }
    
    $.ajax({
        url: "/login",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({n: nickname, p: password}),
        success: function(data) {
            name = data.name;
            key = data.key;
            version = data.version || 0;
            
            $('#login-section').hide();
            $('.chat-container').show();
            $('#chat-section').show();
            $('#chat-box').empty();
            $('#back-btn').show();
            
            addtip('欢迎 <strong>' + name + '</strong> 加入:)', 'tips-warning');
            
            
            
            
            
            get_msg();
            c = setInterval(get_msg, pollingConfig.currentInterval);
            h = setInterval(sendHeartbeat, heartbeatInterval);
        },
        error: function(xhr) {
            if (xhr.status === 401) {
                addtip('管理员密码错误', 'tips-warning');
            } else {
                addtip('登录失败，请重试', 'tips-warning');
            }
        }
    });
}

// 私聊下拉列表相关函数
function togglePrivateDropdown() {
    if (isPrivateDropdownOpen) {
        if (privateDropdownPersistent) {
            // 如果是持久化模式，则手动关闭
            closePrivateDropdown('manual');
        } else {
            // 如果是普通模式，则正常关闭
            closePrivateDropdown();
        }
    } else {
        openPrivateDropdown();
    }
}

function openPrivateDropdown() {
    isPrivateDropdownOpen = true;
    $('#private-dropdown').show();
    checkPrivateChats(); // 立即检查私聊状态
    displayPrivateChatDropdown();
    
    // 如果是持久化模式，添加特殊标记
    if (privateDropdownPersistent) {
        $('#private-dropdown').addClass('persistent');
        $('.private-dropdown-header span:first-child').text('💬 私聊列表 (持续显示)');
    }
}

function closePrivateDropdown() {
    // 只有在非持久化模式下才允许关闭，或者是手动关闭
    if (!privateDropdownPersistent || arguments[0] === 'manual') {
        isPrivateDropdownOpen = false;
        privateDropdownPersistent = false;
        $('#private-dropdown').removeClass('persistent').hide();
        $('.private-dropdown-header span:first-child').text('💬 私聊列表');
    }
}

// 手动关闭私聊列表的函数（给HTML调用）
function closePrivateDropdownManual() {
    closePrivateDropdown('manual');
}

function displayPrivateChatDropdown() {
    var $content = $('#private-dropdown-content');
    $content.empty();
    
    if (!privateChatsData || privateChatsData.length === 0) {
        $content.append('<div class="no-private-chats">暂无活跃的私聊<br><small>点击用户头像可以发起私聊邀请</small></div>');
        return;
    }
    
    privateChatsData.forEach(function(chat) {
        var lastMsgText = chat.last_message ? 
            chat.last_message.content : '点击开始聊天';
        
        // 检查是否有新消息通知
        var notificationClass = privateChatNotifications[chat.chat_id] ? ' has-notification' : '';
        
        var itemHtml = `
            <div class="private-dropdown-item${notificationClass}" onclick="openPrivateChatWindow('${chat.chat_id}', '${chat.other_name}')">
                <div class="dropdown-avatar">${chat.other_name.charAt(0).toUpperCase()}</div>
                <div class="dropdown-info">
                    <div class="dropdown-name">${chat.other_name}</div>
                    <div class="dropdown-preview">${lastMsgText}</div>
                </div>
                <div class="dropdown-actions">
                    <button class="destroy-dropdown-btn" onclick="event.stopPropagation(); destroyPrivateChat('${chat.chat_id}')">销毁</button>
                </div>
            </div>
        `;
        
        $content.append(itemHtml);
    });
}

// 私聊窗口相关函数
function openPrivateChatWindow(chatId, otherName) {
    currentChatId = chatId;
    
    // 清除该聊天的新消息通知
    if (privateChatNotifications[chatId]) {
        delete privateChatNotifications[chatId];
        // 刷新私聊列表显示
        if (isPrivateDropdownOpen) {
            displayPrivateChatDropdown();
        }
    }
    
    // 初始化私聊窗口状态
    privateChatWindow = {
        isOpen: true,
        otherName: otherName,
        isMinimized: false,
        lastUpdate: 0
    };
    
    // 更新窗口标题和显示
    $('#private-chat-title').text('与 ' + otherName + ' 的私聊');
    $('#private-chat-window').removeClass('minimized').show();
    
    // 加载私聊消息
    loadPrivateMessages(chatId);
    
    // 立即检查对方是否还在线
    forceCheckPrivateChatStatus();
    
    // 开始实时检查对方状态（每3秒检查一次）
    if (window.privateChatStatusTimer) {
        clearInterval(window.privateChatStatusTimer);
    }
    window.privateChatStatusTimer = setInterval(function() {
        forceCheckPrivateChatStatus();
    }, 3000);
    
    // 聚焦到输入框
    $('#private-msg').focus();
}

function minimizePrivateChat() {
    // 移除最小化功能，改为返回到私聊列表
    returnToPrivateList();
}

function returnToPrivateList() {
    // 关闭私聊窗口，返回到私聊列表
    currentChatId = null;
    privateChatWindow = null;
    $('#private-chat-window').hide();
    
    // 确保私聊列表显示
    if (!isPrivateDropdownOpen) {
        privateDropdownPersistent = true;
        openPrivateDropdown();
    }
}

// 返回到带私聊弹窗的群聊界面
function returnToGroupWithPrivateList() {
    // 关闭私聊窗口
    currentChatId = null;
    privateChatWindow = null;
    $('#private-chat-window').hide();
    
    // 确保私聊列表持久化显示
    privateDropdownPersistent = true;
    if (!isPrivateDropdownOpen) {
        openPrivateDropdown();
    }
}

// 从私聊窗口销毁当前私聊
function destroyCurrentPrivateChat() {
    if (currentChatId) {
        destroyPrivateChat(currentChatId);
    }
}

function closePrivateChat() {
    currentChatId = null;
    privateChatWindow = null;
    $('#private-chat-window').hide();
    $('#private-chat-indicator').hide();
    
    // 停止实时检查定时器
    if (window.privateChatStatusTimer) {
        clearInterval(window.privateChatStatusTimer);
        window.privateChatStatusTimer = null;
    }
}

// 发送私聊消息（新版本）
function sendPrivateMessage() {
    var msg = $("#private-msg").val().trim();
    if (!msg || !currentChatId) return false;
    
    if (isSending) return;
    isSending = true;
    
    $.ajax({
        url: '/private/send',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
            chat_id: currentChatId,
            message: msg
        }),
        success: function(data) {
            isSending = false;
            if (data.result === 'success') {
                $("#private-msg").val("");
                $("#private-msg").focus();
                // 立即刷新私聊消息
                loadPrivateMessages(currentChatId);
            } else {
                // 发送失败，可能是对方离线，立即销毁私聊
                if (data.message && (data.message.includes('离线') || data.message.includes('结束'))) {
                    // 如果是管理员清空操作进行中，不显示对方离线弹窗
                    if (!adminClearInProgress) {
                        showChatDestroyedDialog('💔 ' + data.message);
                    }
                    closePrivateChat();
                } else {
                    addPrivateTip('发送失败：' + data.message);
                }
            }
        },
        error: function(xhr, status, error) {
            isSending = false;
            if (xhr.status === 400 || xhr.status === 404) {
                // HTTP 400/404错误，可能是对方离线或私聊不存在
                // 如果是管理员清空操作进行中，不显示对方离线弹窗
                if (!adminClearInProgress) {
                    showChatDestroyedDialog('💔 对方已离线，私聊已结束');
                }
                closePrivateChat();
            } else {
                addPrivateTip('网络错误，消息发送失败');
            }
        }
    });
}

// 加载私聊消息（新版本）
function loadPrivateMessages(chatId) {
    if (!chatId) return;
    
    $.getJSON('/private/messages/' + chatId, function(data) {
        if (data.result === 'success') {
            $('#private-chat-body').empty();
            
            if (data.messages.length === 0) {
                addPrivateTip('开始私聊吧！');
            } else {
                data.messages.forEach(function(msg) {
                    var isSelf = (msg.from === key);
                    var position = isSelf ? "right" : "left";
                    var messageContent = msg.msg;
                    var messageType = msg.type || 'text';
                    
                    // 根据消息类型处理内容
                    if (messageType === 'text') {
                        messageContent = convertLinksToHtml(messageContent);
                    }
                    // 文件消息直接使用msg中的HTML内容
                    
                    addPrivateMsg(msg.from_name, messageContent, position, isSelf, msg.timestamp, messageType);
                });
            }
            
            scrollPrivateToBottom();
        } else {
            // 加载消息失败，可能私聊已不存在
            // 如果是管理员清空操作进行中，不显示对方离线弹窗
            if (!adminClearInProgress) {
                showChatDestroyedDialog('💔 对方已离线，私聊已结束');
            }
            closePrivateChat();
        }
    }).fail(function(xhr) {
        // 网络错误或私聊不存在
        if (xhr.status === 404 || xhr.status === 403) {
            // 如果是管理员清空操作进行中，不显示对方离线弹窗
            if (!adminClearInProgress) {
                showChatDestroyedDialog('💔 对方已离线，私聊已结束');
            }
            closePrivateChat();
        }
    });
}

// 私聊窗口与上传等函数已移除