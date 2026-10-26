const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

const app = express();

const PORT = process.env.PORT || 10000;

app.use(cors());

app.use(express.json({
    limit: '10kb'
}));


// Папка для временных MP3
const downloadsDir = path.join(__dirname, 'downloads');

if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, {
        recursive: true
    });
}


// Хранилище активных задач
const tasks = new Map();


function getPythonCommand() {
    return process.platform === 'win32'
        ? 'python'
        : 'python3';
}


function isValidVideoUrl(videoUrl) {
    try {
        const url = new URL(videoUrl);

        return (
            url.protocol === 'http:' ||
            url.protocol === 'https:'
        );

    } catch {
        return false;
    }
}


// Проверка состояния сервера
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        ytDlp: true,
        ffmpeg: Boolean(ffmpegPath)
    });
});


// Запуск конвертации
app.post('/api/convert', (req, res) => {

    const { videoUrl } = req.body || {};

    if (
        typeof videoUrl !== 'string' ||
        !videoUrl.trim()
    ) {
        return res.status(400).json({
            error: 'Ссылка на видео обязательна.'
        });
    }


    const cleanUrl = videoUrl.trim();


    if (!isValidVideoUrl(cleanUrl)) {
        return res.status(400).json({
            error: 'Укажите корректную HTTP/HTTPS-ссылку.'
        });
    }


    if (!ffmpegPath) {
        return res.status(500).json({
            error: 'На сервере не найден FFmpeg.'
        });
    }


    // Уникальный ID задачи
    const taskId =
        `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;


    const outputTemplate =
        path.join(
            downloadsDir,
            `${taskId}.%(ext)s`
        );


    const finalMp3Path =
        path.join(
            downloadsDir,
            `${taskId}.mp3`
        );


    // Сохраняем задачу
    tasks.set(taskId, {
        status: 'processing',
        path: finalMp3Path
    });


    // Сразу отвечаем frontend
    res.json({
        taskId: taskId
    });


    // Запускаем yt-dlp
    const python = getPythonCommand();


    const args = [

        '-m',
        'yt_dlp',

        '--no-playlist',

        '--no-warnings',

        '--restrict-filenames',

        '-x',

        '--audio-format',
        'mp3',

        '--audio-quality',
        '192K',

        '--ffmpeg-location',
        ffmpegPath,

        '-o',
        outputTemplate,

        cleanUrl
    ];


    const child = spawn(
        python,
        args,
        {
            windowsHide: true,

            stdio: [
                'ignore',
                'pipe',
                'pipe'
            ]
        }
    );


    let stderr = '';


    child.stdout.on('data', (data) => {

        console.log(
            `[${taskId}] ${data.toString().trim()}`
        );

    });


    child.stderr.on('data', (data) => {

        stderr += data.toString();

    });


    // Не удалось запустить yt-dlp
    child.on('error', (error) => {

        console.error(
            `[${taskId}] Не удалось запустить yt-dlp:`,
            error
        );


        const task = tasks.get(taskId);

        if (task) {
            task.status = 'error';
        }

    });


    // yt-dlp завершил работу
    child.on('close', (code) => {

        const task = tasks.get(taskId);

        if (!task) {
            return;
        }


        if (
            code === 0 &&
            fs.existsSync(finalMp3Path)
        ) {

            task.status = 'ready';

            console.log(
                `[${taskId}] MP3 готов.`
            );

        } else {

            task.status = 'error';

            console.error(
                `[${taskId}] yt-dlp завершился с кодом ${code}.`
            );


            if (stderr.trim()) {

                console.error(
                    stderr.trim()
                );

            }
        }

    });

});


// Проверка статуса
app.get('/api/status/:taskId', (req, res) => {

    const task =
        tasks.get(req.params.taskId);


    if (!task) {

        return res.status(404).json({
            error: 'Задача не найдена.'
        });

    }


    res.json({
        status: task.status
    });

});


// Скачивание готового MP3
app.get('/api/download/:taskId', (req, res) => {

    const task =
        tasks.get(req.params.taskId);


    if (
        !task ||
        task.status !== 'ready' ||
        !fs.existsSync(task.path)
    ) {

        return res.status(404).json({
            error: 'Файл не найден или еще не готов.'
        });

    }


    res.download(
        task.path,
        'audio.mp3',
        (error) => {

            if (error) {

                console.error(
                    'Ошибка отправки файла:',
                    error
                );

            }


            // После скачивания удаляем файл
            fs.unlink(
                task.path,
                (unlinkError) => {

                    if (
                        unlinkError &&
                        unlinkError.code !== 'ENOENT'
                    ) {

                        console.error(
                            'Ошибка удаления файла:',
                            unlinkError
                        );

                    }

                }
            );


            tasks.delete(
                req.params.taskId
            );

        }
    );

});


// Запуск сервера
app.listen(
    PORT,
    () => {

        console.log(
            `Бэкенд запущен на порту ${PORT}`
        );

    }
);